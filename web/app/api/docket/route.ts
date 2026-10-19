import { searchDockets, courtStats } from '@/lib/chainReads';
import { pageNumber } from '@/lib/protocol';
import { CASE_STATUSES } from '@/types/ombuds';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const query = new URL(req.url).searchParams;
  const status = query.get('status') ?? '';
  if (status && !CASE_STATUSES.includes(status as never)) return Response.json({ error: 'Unknown status.' }, { status: 400 });
  const offset = pageNumber(query.get('offset'));
  const limit = Math.max(1, pageNumber(query.get('limit'), 25, 100));
  const [page, stats] = await Promise.all([searchDockets((query.get('q') ?? '').slice(0, 100), status, query.get('plan') ?? '', '', offset, limit), courtStats()]);
  if (!page) return Response.json({ error: 'The court could not be read.' }, { status: 502 });
  return Response.json({ source: 'chain', rows: page.items, total: page.total, offset, limit, chainStats: stats });
}
