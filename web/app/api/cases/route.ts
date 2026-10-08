import { createHash } from 'node:crypto';
import { z } from 'zod';

import { buildCaseRecord } from '@/lib/deident';
import { insertCase, listCasesForMember, recordSourceSnapshot } from '@/lib/db';
import { ombudsCourtAddress, ReceiptTimeoutError, writeContract } from '@/lib/genlayer';
import { authErrorResponse, requireMember } from '@/lib/privy';
import { parseUsdToAtto } from '@/lib/bands';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const Body = z.object({
  planId: z.string().min(1),
  familyId: z.string().min(1),
  state: z.string().length(2),
  letterText: z.string().min(1).max(60000),
  denialRationale: z.string().min(10).max(2000),
  denialReasonCode: z.string().max(12).default(''),
  serviceDate: z.string().min(4),
  disputedAmount: z.string().min(1),
  sourceUrls: z.array(z.string().url()).default([]),
  cptCodes: z.array(z.string()).optional(),
  icd10Codes: z.array(z.string()).optional(),
  evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  evidenceBytes: z.string().optional(),
  payoutAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  filerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});

/** The cases this member has filed. */
export async function GET(req: Request) {
  try {
    const member = await requireMember(req);
    const cases = await listCasesForMember(member.id);
    return Response.json({
      cases: cases.map((row) => ({ ...row, disputed_amount_atto: row.disputed_amount_atto.toString() })),
    });
  } catch (err) {
    return authErrorResponse(err);
  }
}

/**
 * File a case.
 *
 * The de-identification runs here, on the server, before anything is signed. If
 * buildCaseRecord cannot produce a record that is clean, it throws and nothing is written.
 * The chain then runs its own tripwire over the same fields, so a leak would have to get
 * past two independent checks written at different layers.
 */
export async function POST(req: Request) {
  let member;
  try {
    member = await requireMember(req);
  } catch (err) {
    return authErrorResponse(err);
  }

  let input;
  try {
    input = Body.parse(await req.json());
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'That form could not be read.';
    return Response.json({ error: `Some of those details did not look right. ${detail}` }, { status: 400 });
  }

  const evidenceSha256 =
    input.evidenceSha256 ??
    createHash('sha256').update(input.letterText, 'utf8').digest('hex');

  let built;
  try {
    built = await buildCaseRecord({
      planId: input.planId,
      familyId: input.familyId,
      state: input.state,
      letterText: input.letterText,
      denialRationale: input.denialRationale,
      denialReasonCode: input.denialReasonCode,
      serviceDate: input.serviceDate,
      disputedAmount: parseUsdToAtto(input.disputedAmount),
      sourceUrls: input.sourceUrls,
      cptCodes: input.cptCodes,
      icd10Codes: input.icd10Codes,
      evidenceSha256,
    });
  } catch (err) {
    // A PhiLeakError lands here. It names the field and the kind, never the value.
    return Response.json(
      {
        error:
          err instanceof Error
            ? `We stopped before sending anything. ${err.message}`
            : 'We stopped before sending anything, because the letter still looked identifying.',
      },
      { status: 422 },
    );
  }

  const record = built.record;
  const filerAddress =
    input.payoutAddress ??
    input.filerAddress ??
    member.memberAddress;

  let write;
  try {
    write = await writeContract({
      address: ombudsCourtAddress(),
      functionName: 'file_case',
      args: [
        record.plan_id,
        record.family_id,
        record.state,
        record.cpt_codes.join('|'),
        record.icd10_codes.join('|'),
        record.denial_reason_code,
        record.denial_rationale,
        record.service_month,
        record.disputed_amount_atto.toString(),
        record.evidence_sha256,
        filerAddress,
      ],
    });
  } catch (err) {
    if (err instanceof ReceiptTimeoutError) {
      // The docket number comes back in the receipt, so without a receipt there
      // is no docket to hand over and nothing is written to the index. The
      // filing itself is on chain and the docket page reads from the contract.
      return Response.json(
        {
          pending: true,
          docket: null,
          txHash: err.txHash,
          message:
            'The filing is on chain but the court had not issued a docket number by the time ' +
            'this request had to end. It appears on the docket page shortly.',
        },
        { status: 202 },
      );
    }
    throw err;
  }

  if (!write.ok) {
    return Response.json(
      {
        error:
          write.error ??
          'The court refused that filing and did not say why. Nothing was charged and nothing was stored.',
        status: write.status,
        txHash: write.txHash,
      },
      { status: 422 },
    );
  }

  const docket = readDocket(write.receipt);

  if (docket !== null) {
    await insertCase({
      docket,
      memberId: member.id,
      planId: record.plan_id,
      familyId: record.family_id,
      state: record.state,
      cptCodes: record.cpt_codes,
      icd10Codes: record.icd10_codes,
      denialReasonCode: record.denial_reason_code,
      denialRationale: record.denial_rationale,
      serviceMonth: record.service_month,
      disputedAmountAtto: record.disputed_amount_atto,
      evidenceSha256: record.evidence_sha256,
      chainTx: write.txHash,
      status: 'FILED',
    });

    for (const url of record.source_urls) {
      await recordSourceSnapshot({ docket, url, kind: 'PLAN_BULLETIN', contentSha256: ''.padEnd(64, '0') });
    }
  }

  return Response.json({
    docket,
    txHash: write.txHash,
    status: write.status,
    dropped: built.dropped,
    redactions: built.redactions,
  });
}

/** The docket string the contract returned. */
function readDocket(receipt: unknown): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [receipt];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined || seen.has(node)) continue;
    if (typeof node === 'string') {
      const match = node.match(/OMB-\d{4}-\d{6}/);
      if (match !== null) return match[0];
      continue;
    }
    if (typeof node === 'object') {
      seen.add(node);
      for (const value of Object.values(node as Record<string, unknown>)) stack.push(value);
    }
  }
  return null;
}
