import { z } from 'zod';

import { recordPoolEvent } from '@/lib/db';
import { advancePoolAddress, readContract, writeContract } from '@/lib/genlayer';
import { authErrorResponse, requireMember } from '@/lib/privy';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Pool stats and the advance ledger, read from chain. */
export async function GET() {
  try {
    const pool = advancePoolAddress();
    const [stats, config, ledger] = await Promise.all([
      readContract<Record<string, unknown>>({ address: pool, functionName: 'pool_stats' }),
      readContract<Record<string, unknown>>({ address: pool, functionName: 'get_config' }),
      readContract<unknown[]>({ address: pool, functionName: 'advance_ledger', args: [25] }),
    ]);
    return Response.json({ pool, stats, config, ledger });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'The pool could not be read.' },
      { status: 502 },
    );
  }
}

const Body = z.object({ docket: z.string().regex(/^OMB-\d{4}-\d{6}$/) });

/**
 * Trigger an advance.
 *
 * Permissionless at the contract, and it stays that way here: the money can only ever go
 * to the address that filed the case, because the pool reads that address off the court
 * rather than taking it from whoever made the request.
 */
export async function POST(req: Request) {
  try {
    await requireMember(req);
  } catch (err) {
    return authErrorResponse(err);
  }

  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return Response.json({ error: 'Send a docket number.' }, { status: 400 });
  }

  const pool = advancePoolAddress();

  const quote = await readContract<{ eligible: boolean; reason: string; amount_atto: string }>({
    address: pool,
    functionName: 'quote_advance',
    args: [body.docket],
  });

  if (!quote.eligible) {
    return Response.json({ error: quote.reason, quote }, { status: 409 });
  }

  const write = await writeContract({
    address: pool,
    functionName: 'advance',
    args: [body.docket],
  });

  if (!write.ok) {
    return Response.json(
      { error: write.error ?? 'The pool could not advance against that case.', txHash: write.txHash },
      { status: 422 },
    );
  }

  await recordPoolEvent({
    kind: 'ADVANCE',
    actor: 'pool',
    amountAtto: BigInt(quote.amount_atto),
    docket: body.docket,
    txHash: write.txHash,
  }).catch(() => undefined);

  return Response.json({
    docket: body.docket,
    amountAtto: quote.amount_atto,
    txHash: write.txHash,
    status: write.status,
  });
}
