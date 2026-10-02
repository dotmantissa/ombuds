import { indexHealth } from '@/lib/db';
import { ombudsCourtAddress, planRegistryAddress, readContract, rpcEndpoint } from '@/lib/genlayer';

export const dynamic = 'force-dynamic';

/** Is the index up, and is the chain answering. Used by the footer status and by me. */
export async function GET() {
  const index = await indexHealth();

  let chain = { ok: false, detail: 'The chain could not be reached.', rules: 0 };
  try {
    const stats = await readContract<{ rule_count: number }>({
      address: planRegistryAddress(),
      functionName: 'registry_stats',
    });
    chain = { ok: true, detail: 'The chain is answering.', rules: Number(stats.rule_count ?? 0) };
  } catch (err) {
    chain = {
      ok: false,
      detail: err instanceof Error ? err.message : 'The chain could not be reached.',
      rules: 0,
    };
  }

  return Response.json({
    index,
    chain,
    endpoint: rpcEndpoint(),
    court: safely(() => ombudsCourtAddress()),
    registry: safely(() => planRegistryAddress()),
  });
}

function safely(fn: () => string): string | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
