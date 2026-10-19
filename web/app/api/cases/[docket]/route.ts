import { getCaseByDocket } from '@/lib/db';
import { ombudsCourtAddress, readContract } from '@/lib/genlayer';

export const dynamic = 'force-dynamic';

const DOCKET = /^OMB-\d{4}-\d{6}$/;

/**
 * One case, read from chain.
 *
 * The index is consulted only for the things the chain does not hold, and the response
 * says which parts came from where. The verdict always comes from the contract, because
 * the index is not allowed to be the reason anybody believes a verdict.
 */
export async function GET(_req: Request, context: { params: Promise<{ docket: string }> }) {
  const { docket } = await context.params;
  if (!DOCKET.test(docket)) {
    return Response.json({ error: 'That does not look like a docket number.' }, { status: 400 });
  }

  const court = ombudsCourtAddress();

  let chainCase: Record<string, unknown>;
  try {
    chainCase = await readContract<Record<string, unknown>>({
      address: court,
      functionName: 'get_case',
      args: [docket],
    });
  } catch {
    return Response.json({ error: 'The court could not return this case. Refresh to check its availability.' }, { status: 502 });
  }

  let verdict: Record<string, unknown> | null = null;
  if (chainCase.has_verdict === true) {
    try {
      verdict = await readContract<Record<string, unknown>>({
        address: court,
        functionName: 'get_verdict',
        args: [docket],
      });
    } catch {
      verdict = null;
    }
  }

  let advanceable: Record<string, unknown> | null = null;
  try {
    advanceable = await readContract<Record<string, unknown>>({
      address: court,
      functionName: 'is_advanceable',
      args: [docket],
    });
  } catch {
    advanceable = null;
  }

  const indexed = await getCaseByDocket(docket).catch(() => null);

  return Response.json({
    docket,
    source: 'chain',
    case: chainCase,
    verdict,
    advanceable,
    indexed:
      indexed === null
        ? null
        : { ...indexed, disputed_amount_atto: indexed.disputed_amount_atto.toString() },
    note: 'The case and the verdict come from the contract. The index is used only for search and history.',
  });
}
