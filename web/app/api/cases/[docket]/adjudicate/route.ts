import { trackedWrite, existingOperationResponse } from '@/lib/operations';
import { recordVerdict, updateCaseStatus } from '@/lib/db';
import {
  type ChainAddress,
  ombudsCourtAddress,
  readContract,
  ReceiptTimeoutError,
} from '@/lib/genlayer';
import { authErrorResponse, requireMember } from '@/lib/privy';
import { isCaseStatus } from '@/types/ombuds';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const DOCKET = /^OMB-\d{4}-\d{6}$/;

/**
 * Mirror the status the contract actually reports.
 *
 * Adjudication does not have one landing state any more. A first reading ends at VERDICT,
 * but a re-reading of a case with a bond outstanding ends at REVIEWED, and the difference
 * is the whole of what makes the appeal settleable. Asserting either one from here would
 * be the index inventing a fact, so it is read back instead. A status this build does not
 * recognise is a reason to leave the index alone rather than write a guess into it.
 */
async function mirrorChainStatus(court: ChainAddress, docket: string, txHash?: string) {
  try {
    const kase = await readContract<{ status: string }>({
      address: court,
      functionName: 'get_case',
      args: [docket],
    });
    const onChain = String(kase.status);
    if (isCaseStatus(onChain)) {
      await updateCaseStatus(docket, onChain, txHash);
    }
  } catch {
    // The index is not the record. Failing to refresh it is not worth failing the
    // request the member actually made.
  }
}

/**
 * Send a case to the panel.
 *
 * This is the slow one. Every validator re-fetches the bulletin and the coverage
 * determination, re-audits the codes, asks the question again, and then has to agree on
 * the decision, the ground, the clause and the band. That takes as long as it takes.
 */
export async function POST(req: Request, context: { params: Promise<{ docket: string }> }) {
  let member;
  try {
    member = await requireMember(req);
  } catch (err) {
    return authErrorResponse(err);
  }

  const { docket } = await context.params;
  if (!DOCKET.test(docket)) {
    return Response.json({ error: 'That does not look like a docket number.' }, { status: 400 });
  }

  const court = ombudsCourtAddress();
  const current = await readContract<{ status: string; panel_round: number }>({ address: court, functionName: 'get_case', args: [docket] });


  let write;
  try {
    write = await trackedWrite(member.id, req.headers.get('idempotency-key') ?? `adjudicate_${docket}_${current.panel_round}`, {
      address: court,
      functionName: 'adjudicate',
      args: [docket],
    }, docket);
  } catch (err) {
    const existing = existingOperationResponse(err);
    if (existing) return existing;
    if (err instanceof ReceiptTimeoutError) {
      // The case stays ADJUDICATING, which is exactly the truth: the panel has it
      // and has not finished. The case page reads the verdict off the contract,
      // so it shows up there whether or not this request lived long enough to
      // see it land.
      return Response.json(
        {
          pending: true,
          docket,
          txHash: err.txHash,
          message:
            'The panel is still sitting. The case stays open and the verdict appears on its ' +
            'page as soon as the validators agree.',
        },
        { status: 202 },
      );
    }
    await mirrorChainStatus(court, docket);
    return Response.json({ error: 'The transaction could not be confirmed. Check its history before trying again.' }, { status: 502 });
  }

  if (!write.ok) {
    await mirrorChainStatus(court, docket);
    return Response.json(
      {
        error: write.error ?? 'The panel could not reach a verdict on that case.',
        status: write.status,
        executionResult: write.executionResult,
        txHash: write.txHash,
      },
      { status: 422 },
    );
  }

  // The authoritative verdict is read back off the contract rather than parsed out of a
  // receipt, so what gets indexed is exactly what the chain holds.
  const verdict = await readContract<{
    overturn_recommended: boolean;
    ground: string;
    clause_id: string;
    clause_section: string;
    clause_quote: string;
    recoverable_band: number;
    confidence: number;
    digest: string;
    citations: unknown[];
    reasoning: string;
    panel_round: number;
  }>({ address: court, functionName: 'get_verdict', args: [docket] });

  await recordVerdict({
    docket,
    overturnRecommended: Boolean(verdict.overturn_recommended),
    ground: String(verdict.ground),
    clauseId: String(verdict.clause_id),
    clauseSection: String(verdict.clause_section),
    clauseQuote: String(verdict.clause_quote),
    recoverableBand: Number(verdict.recoverable_band),
    confidence: Number(verdict.confidence),
    digest: String(verdict.digest),
    citations: verdict.citations ?? [],
    reasoning: String(verdict.reasoning),
    txHash: write.txHash,
    panelRound: Number(verdict.panel_round ?? 1),
  }).catch(() => undefined);

  await mirrorChainStatus(court, docket, write.txHash);

  return Response.json({ docket, txHash: write.txHash, status: write.status, verdict });
}
