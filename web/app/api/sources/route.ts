import { loadSources, sourcesPath } from '@/lib/sources';

export const dynamic = 'force-dynamic';

/**
 * The source dataset.
 *
 * Public on purpose. Every URL Ombuds reads, every statute citation, every code set and the
 * HTTP status each one answered with when it was last checked. If you want to argue with a
 * verdict, start here.
 */
export async function GET() {
  const data = await loadSources();
  if (data === null) {
    return Response.json(
      { error: 'The source dataset is not readable right now.' },
      { status: 500 },
    );
  }
  return Response.json(
    { ...data, _readFrom: sourcesPath() },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}
