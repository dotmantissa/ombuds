import { trackedWrite, existingOperationResponse } from './operations';
/**
 * Filing a case: what the chain is told, and who the money belongs to.
 *
 * SERVER ONLY. It reaches the relayer and the index.
 *
 * The two decisions in here used to be inline expressions in the route handler, which
 * made them impossible to test without a live Privy session and a funded relayer. Both
 * decide where a member's money goes, so both are lifted out and both are covered:
 *
 *   resolveEvidenceCommitment  what hash the court is asked to commit to
 *   resolvePayoutAddress       which address the advance and the bond will be paid to
 *
 * The handlers underneath take their collaborators as an argument with a live default, so
 * a test can drive the whole path — auth, validation, de-identification, the chain call,
 * the index write — without a network.
 */

import { z } from 'zod';

import { normaliseAddress, ZERO_ADDRESS } from './address';
import { buildCaseRecord, sha256Hex, PhiLeakError } from './deident';
import { insertCase, listCasesForMember, recordSourceSnapshot } from './db';
import {
  ombudsCourtAddress,
  ReceiptTimeoutError,
  writeContract,
  type WriteResult,
} from './genlayer';
import { authErrorResponse, requireMember, type AuthenticatedMember } from './privy';
import { parseUsdToAtto } from './bands';
import type { DocketRow } from '@/types/ombuds';

/** 64 lowercase hex characters, which is what OmbudsCourt.file_case demands. */
export const HEX64 = /^[0-9a-f]{64}$/;

/**
 * A refusal a member can act on, carrying the status the route should answer with.
 *
 * Separate from AuthError because this is not about who they are. The message is read by
 * a person who is halfway through filing an appeal, so it says what to do next.
 */
export class FilingRefused extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FilingRefused';
    this.status = status;
  }
}

/* ---------------------------------------------------------------------------
   The evidence commitment
   --------------------------------------------------------------------------- */

/**
 * Where the digest the court commits to came from.
 *
 * `browser_digest` is the normal path: the wizard hashes the letter on the member's own
 * machine. `document_bytes` is a client that posted the document instead of hashing it.
 * `letter_text` is the server doing the hashing itself, which produces the same digest as
 * `browser_digest` for the same letter and exists so a filing never fails for want of a
 * commitment it could have computed.
 */
export type EvidenceOrigin = 'browser_digest' | 'document_bytes' | 'letter_text';

export interface EvidenceCommitment {
  sha256: string;
  origin: EvidenceOrigin;
}

/** The lowercase 64 hex form of a digest, or null when it is not one. */
export function normaliseDigest(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase();
  return HEX64.test(cleaned) ? cleaned : null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strict base64 to bytes. Whitespace is allowed; anything else is refused by name. */
export function decodeBase64(value: string): Uint8Array {
  const packed = value.replace(/\s+/g, '');
  if (packed === '' || packed.length % 4 !== 0 || !BASE64.test(packed)) {
    throw new FilingRefused('evidenceBytes was not valid base64.', 400);
  }
  const binary = atob(packed);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface EvidenceInput {
  evidenceSha256?: string | null;
  /** The original document, base64. Hashed and then dropped; never stored, never sent. */
  evidenceBytes?: string | null;
  letterText: string;
}

/**
 * The digest the court will commit to, and where it came from.
 *
 * A supplied digest wins, because the member's own machine is the only place that has
 * seen the original document. When the bytes are sent alongside it the two are checked
 * against each other: a commitment that does not match the document it claims to commit
 * to is worse than no commitment at all, so the mismatch is refused rather than resolved
 * in favour of one of them.
 */
export async function resolveEvidenceCommitment(
  input: EvidenceInput,
): Promise<EvidenceCommitment> {
  const claimed = typeof input.evidenceSha256 === 'string' ? input.evidenceSha256.trim() : '';
  const packed = typeof input.evidenceBytes === 'string' ? input.evidenceBytes.trim() : '';

  if (claimed !== '') {
    const digest = normaliseDigest(claimed);
    if (digest === null) {
      throw new FilingRefused(
        'evidenceSha256 has to be 64 hex characters, which is what a SHA-256 digest is.',
        400,
      );
    }
    if (packed !== '') {
      const computed = await sha256Hex(decodeBase64(packed));
      if (computed !== digest) {
        throw new FilingRefused(
          'The evidence digest does not match the document sent with it, so nothing was ' +
            'filed. Reload the page and try that again.',
          422,
        );
      }
    }
    return { sha256: digest, origin: 'browser_digest' };
  }

  if (packed !== '') {
    return { sha256: await sha256Hex(decodeBase64(packed)), origin: 'document_bytes' };
  }

  if (input.letterText.trim() === '') {
    throw new FilingRefused(
      'There is nothing to commit to. Paste the denial letter and try again.',
      400,
    );
  }

  return { sha256: await sha256Hex(input.letterText), origin: 'letter_text' };
}

/* ---------------------------------------------------------------------------
   Who the money belongs to
   --------------------------------------------------------------------------- */

export interface PayoutInput {
  /** An address the member nominated on the form. Optional. */
  payoutAddress?: string | null;
  /** The member's own verified address, or null when they do not have one. */
  memberAddress?: string | null;
}

/**
 * The address a filing is bound to: the advance recipient and the bond recipient.
 *
 * It is never the relayer. A relayed filing that records the relayer as the filer makes
 * the relayer the owner of the member's case and the payee of their advance, and the
 * chain then says the wrong thing about whose claim it is.
 *
 * It is never derived either. An address that is merely address shaped — a hash of the
 * member's Privy DID, for instance — has no private key behind it, so every advance paid
 * there is destroyed. When there is no real address to use, this refuses and says so,
 * because telling a member to nominate one is better than paying them into a void.
 */
export function resolvePayoutAddress(input: PayoutInput): string {
  const nominated = typeof input.payoutAddress === 'string' ? input.payoutAddress.trim() : '';

  if (nominated !== '') {
    const cleaned = normaliseAddress(nominated);
    if (cleaned === null) {
      throw new FilingRefused(
        'That payout address is not a 0x address followed by 40 hex characters.',
        400,
      );
    }
    if (cleaned === ZERO_ADDRESS) {
      throw new FilingRefused(
        'That payout address is the zero address, and nothing paid there can ever be ' +
          'collected. Use an address you hold the key to.',
        400,
      );
    }
    return cleaned;
  }

  const member = normaliseAddress(input.memberAddress);
  if (member === null || member === ZERO_ADDRESS) {
    throw new FilingRefused(
      'We do not have an address to pay you at yet. Sign out and sign in again so your ' +
        'member wallet is created, or enter a payout address on the form.',
      400,
    );
  }
  return member;
}

/* ---------------------------------------------------------------------------
   The request body
   --------------------------------------------------------------------------- */

export const FilingBody = z.object({
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
  evidenceSha256: z.string().optional(),
  evidenceBytes: z.string().optional(),
  payoutAddress: z.string().optional(),
});

export type FilingInput = z.infer<typeof FilingBody>;

/* ---------------------------------------------------------------------------
   The handlers
   --------------------------------------------------------------------------- */

export interface FilingDeps {
  requireMember: (req: Request) => Promise<AuthenticatedMember>;
  buildCaseRecord: typeof buildCaseRecord;
  writeContract: (params: {
    address: `0x${string}`;
    functionName: string;
    args?: unknown[];
  }) => Promise<WriteResult>;
  courtAddress: () => `0x${string}`;
  insertCase: typeof insertCase;
  recordSourceSnapshot: typeof recordSourceSnapshot;
  listCasesForMember: (memberId: string) => Promise<DocketRow[]>;
}

/** The real collaborators. Every one of them needs an environment or a network. */
export const liveFilingDeps: FilingDeps = {
  requireMember,
  buildCaseRecord,
  writeContract: writeContract as FilingDeps['writeContract'],
  courtAddress: ombudsCourtAddress,
  insertCase,
  recordSourceSnapshot,
  listCasesForMember,
};

/** The cases this member has filed. */
export async function listFiledCases(
  req: Request,
  deps: FilingDeps = liveFilingDeps,
): Promise<Response> {
  try {
    const member = await deps.requireMember(req);
    const cases = await deps.listCasesForMember(member.id);
    return Response.json({
      cases: cases.map((row) => ({
        ...row,
        disputed_amount_atto: row.disputed_amount_atto.toString(),
      })),
    });
  } catch (err) {
    return authErrorResponse(err);
  }
}

/**
 * File a case.
 *
 * The de-identification runs here, on the server, before anything is signed. If
 * buildCaseRecord cannot produce a record that is clean, it throws and nothing is
 * written. The chain then runs its own tripwire over the same fields, so a leak would
 * have to get past two independent checks written at different layers.
 */
export async function fileCase(
  req: Request,
  deps: FilingDeps = liveFilingDeps,
): Promise<Response> {
  let member: AuthenticatedMember;
  try {
    member = await deps.requireMember(req);
  } catch (err) {
    return authErrorResponse(err);
  }

  let input: FilingInput;
  try {
    input = FilingBody.parse(await req.json());
  } catch {
    const detail = 'Review the required fields and their formats.';
    return Response.json(
      { error: `Some of those details did not look right. ${detail}` },
      { status: 400 },
    );
  }

  // Both of these refuse rather than guess. One decides what the record commits to, the
  // other decides who gets paid, and a wrong answer to either is not recoverable later.
  let evidence: EvidenceCommitment;
  let payoutAddress: string;
  try {
    evidence = await resolveEvidenceCommitment(input);
    payoutAddress = resolvePayoutAddress({
      payoutAddress: input.payoutAddress,
      memberAddress: member.memberAddress,
    });
  } catch (err) {
    if (err instanceof FilingRefused) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let built;
  try {
    built = await deps.buildCaseRecord({
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
      evidenceSha256: evidence.sha256,
    });
  } catch (err) {
    // A PhiLeakError lands here. It names the field and the kind, never the value.
    return Response.json(
      {
        error:
          err instanceof PhiLeakError
            ? `We stopped before sending anything. ${err.message}`
            : 'We stopped before sending anything. Review the sanitized record, dates, codes and amount.',
      },
      { status: 422 },
    );
  }

  const record = built.record;

  let write: WriteResult;
  try {
    const submit = deps === liveFilingDeps
      ? (params: Parameters<typeof writeContract>[0]) => trackedWrite(member.id,
          req.headers.get('idempotency-key') ?? `file_${evidence.sha256}`, params)
      : deps.writeContract;
    write = await submit({
      address: deps.courtAddress(),
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
        payoutAddress,
      ],
    });
  } catch (err) {
    const existing = existingOperationResponse(err);
    if (existing) return existing;
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
          'The court refused that filing. Review the sanitized record and registered rule before trying again.',
        status: write.status,
        txHash: write.txHash,
      },
      { status: 422 },
    );
  }

  const docket = readDocket(write.receipt);

  if (docket !== null) {
    await deps.insertCase({
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

    // Source snapshots belong to the actual validator fetch, never a placeholder
    // hash created while filing. Per-round provenance is read from the court.

  }

  return Response.json({
    docket,
    txHash: write.txHash,
    status: write.status,
    dropped: built.dropped,
    redactions: built.redactions,
    evidenceSha256: record.evidence_sha256,
    evidenceOrigin: evidence.origin,
    payoutAddress,
  });
}

/** The docket string the contract returned. */
export function readDocket(receipt: unknown): string | null {
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
