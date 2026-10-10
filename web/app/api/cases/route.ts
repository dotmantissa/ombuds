import { fileCase, listFiledCases } from '@/lib/filing';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The cases this member has filed, and filing a new one.
 *
 * Both handlers live in lib/filing.ts, which takes its collaborators as an argument so
 * the whole path can be driven in a test without a Privy session or a funded relayer.
 */
export async function GET(req: Request) {
  return listFiledCases(req);
}

export async function POST(req: Request) {
  return fileCase(req);
}
