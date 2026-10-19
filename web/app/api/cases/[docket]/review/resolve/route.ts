import { memberOwnsCase } from '@/lib/db';
import { trackedWrite, existingOperationResponse } from '@/lib/operations';
import { updateCaseStatus } from '@/lib/db';
import {
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
 * Close an appeal and release the bond.
 *
 * The contract works out who the bond belongs to by itself, by comparing the ruling the
 * fresh panel reached against the one pinned when the review opened. Nobody here gets to
 * assert who won, which is the point: this route carries no argument, only a docket.
 *
 * Once the panel has ruled, anyone may close it. That is deliberate. If closing were an
 * administrator's privilege, an administrator who never got round to it would leave
 * somebody else's bond sitting in the contract indefinitely.
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
  if (current.status === 'UNDER_REVIEW' && !(await memberOwnsCase(member.id, docket))) {
    return Response.json({ error: 'Only the case owner can abandon a sponsored appeal before it is heard.' }, { status: 403 });
  }


  let write;
  try {
    write = await trackedWrite(member.id, req.headers.get('idempotency-key') ?? `resolve_${docket}_${current.panel_round}`, {
      address: court,
      functionName: 'resolve_review',
      args: [docket],
    }, docket);
  } catch (err) {
    const existing = existingOperationResponse(err);
    if (existing) return existing;
    if (err instanceof ReceiptTimeoutError) {
      return Response.json(
        {
          pending: true,
          docket,
          txHash: err.txHash,
          message:
            'The closing transaction is on chain and the validators have not finished with ' +
            'it. The bond shows as released on this page once they have.',
        },
        { status: 202 },
      );
    }
    return Response.json({ error: 'The transaction could not be confirmed. Check its history before trying again.' }, { status: 502 });
  }

  if (!write.ok) {
    return Response.json(
      { error: write.error ?? 'That appeal could not be closed.', txHash: write.txHash },
      { status: 422 },
    );
  }

  // Read the case back off the contract rather than assuming where it landed. The index
  // is not the record and must never claim a status the chain has not reported.
  const kase = await readContract<{ status: string }>({
    address: court,
    functionName: 'get_case',
    args: [docket],
  });
  const onChain = String(kase.status);
  // Only mirror a status the type system recognises. A chain that reports something this
  // build has never heard of is a reason to leave the index alone, not to write a guess
  // into it.
  if (isCaseStatus(onChain)) {
    await updateCaseStatus(docket, onChain, write.txHash).catch(() => undefined);
  }

  return Response.json({ docket, txHash: write.txHash, status: onChain });
}
