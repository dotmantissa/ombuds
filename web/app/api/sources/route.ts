import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

/**
 * The source dataset, straight off disk.
 *
 * Public on purpose. Every URL Ombuds reads, every statute citation, every code set and
 * the HTTP status each one answered with when it was last checked. If you want to argue
 * with a verdict, start here.
 */
export async function GET() {
  try {
    const file = path.join(process.cwd(), '..', 'data', 'sources.json');
    const text = await readFile(file, 'utf8');
    return new Response(text, {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    });
  } catch {
    return Response.json({ error: 'The source dataset is not readable right now.' }, { status: 500 });
  }
}
