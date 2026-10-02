import { docketStats, listPublicDocket, searchCases } from '@/lib/db';
import { ombudsCourtAddress, readContract } from '@/lib/genlayer';

export const dynamic = 'force-dynamic';

/**
 * The public docket.
 *
 * The list comes from the index because that is what an index is for. The headline counts
 * come from the contract, so the numbers on the page are the chain's numbers and not a
 * cached guess.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const limit = Number(url.searchParams.get('limit') ?? '25');
  const offset = Number(url.searchParams.get('offset') ?? '0');

  const rows = await (q === '' ? listPublicDocket(limit, offset) : searchCases(q, limit)).catch(
    () => [],
  );

  let chainStats: Record<string, unknown> | null = null;
  try {
    chainStats = await readContract<Record<string, unknown>>({
      address: ombudsCourtAddress(),
      functionName: 'court_stats',
    });
  } catch {
    chainStats = null;
  }

  const indexStats = await docketStats().catch(() => null);

  return Response.json({
    rows: rows.map((row) => ({ ...row, disputed_amount_atto: row.disputed_amount_atto.toString() })),
    chainStats,
    indexStats:
      indexStats === null
        ? null
        : { ...indexStats, total_disputed_atto: indexStats.total_disputed_atto.toString() },
    query: q,
  });
}
