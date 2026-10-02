import { updateCaseStatus } from '@/lib/db';
import { ombudsCourtAddress, readContract, writeContract } from '@/lib/genlayer';
import { authErrorResponse, requireMember } from '@/lib/privy';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const DOCKET = /^OMB-\d{4}-\d{6}$/;

/**
 * Escalate a verdict to a fresh panel.
 *
 * The honest answer to "what if the machine got it wrong". A bond is posted, a different
 * set of validators reads the case again, and the bond goes to whoever turns out to be
 * right. The relayer posts the bond so the member does not have to hold a token.
 */
export async function POST(req: Request, context: { params: Promise<{ docket: string }> }) {
  try {
    await requireMember(req);
  } catch (err) {
    return authErrorResponse(err);
  }

  const { docket } = await context.params;
  if (!DOCKET.test(docket)) {
    return Response.json({ error: 'That does not look like a docket number.' }, { status: 400 });
  }

  const court = ombudsCourtAddress();

  const config = await readContract<{ review_bond_atto: string }>({
    address: court,
    functionName: 'get_config',
  });
  const bond = BigInt(config.review_bond_atto ?? '0');

  const write = await writeContract({
    address: court,
    functionName: 'request_review',
    args: [docket],
    value: bond,
  });

  if (!write.ok) {
    return Response.json(
      { error: write.error ?? 'That case could not be sent back for review.', txHash: write.txHash },
      { status: 422 },
    );
  }

  await updateCaseStatus(docket, 'UNDER_REVIEW', write.txHash).catch(() => undefined);

  return Response.json({
    docket,
    txHash: write.txHash,
    status: write.status,
    bondAtto: bond.toString(),
  });
}
