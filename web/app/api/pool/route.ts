import { z } from 'zod';

import { recordPoolEvent } from '@/lib/db';
import { trackedWrite, existingOperationResponse } from '@/lib/operations';
import {
  advancePoolAddress,
  readContract,
  ReceiptTimeoutError,
} from '@/lib/genlayer';
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
  let member;
  try {
    member = await requireMember(req);
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

  let write;
  try {
    write = await trackedWrite(member.id, req.headers.get('idempotency-key') ?? `advance_${body.docket}`, {
      address: pool,
      functionName: 'advance',
      args: [body.docket],
    }, body.docket);
  } catch (err) {
    const existing = existingOperationResponse(err);
    if (existing) return existing;
    if (err instanceof ReceiptTimeoutError) {
      // Nothing is recorded as advanced. The pool's own ledger is the record and
      // the pool page reads it from the contract.
      return Response.json(
        {
          pending: true,
          docket: body.docket,
          txHash: err.txHash,
          message:
            'The advance is on chain and had not settled by the time this request had to ' +
            'end. The pool ledger shows it once it does.',
        },
        { status: 202 },
      );
    }
    return Response.json({ error: 'The advance could not be confirmed. Check transaction history before retrying.' }, { status: 502 });
  }

  if (!write.ok) {
    return Response.json(
      { error: write.error ?? 'The pool could not advance against that case.', txHash: write.txHash },
      { status: 422 },
    );
  }

  const actual = await readContract<{ amount_atto: string; payout_id: string }>({ address: pool, functionName: 'get_advance', args: [body.docket] });
  await recordPoolEvent({
    kind: 'ADVANCE',
    actor: 'pool',
    amountAtto: BigInt(actual.amount_atto),
    docket: body.docket,
    txHash: write.txHash,
  }).catch(() => undefined);

  return Response.json({
    docket: body.docket,
    amountAtto: actual.amount_atto,
    payoutId: actual.payout_id,
    paymentStatus: 'PENDING',
    txHash: write.txHash,
    status: write.status,
  });
}
