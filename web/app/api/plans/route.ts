import { planRegistryAddress, readContract } from '@/lib/genlayer';

export const dynamic = 'force-dynamic';

interface ChainRule {
  plan_id: string;
  insurer: string;
  plan_line: string;
  family_id: string;
  bulletin_number: string;
  bulletin_title: string;
  bulletin_url: string;
  state: string;
  effective_from: string;
  effective_to: string;
  cms_display_id: string;
  cms_source_url: string;
  clause_sections: string[];
  content_hash: string;
  last_refreshed: string;
  refresh_count: number;
  revision_count: number;
  retired: boolean;
  active: boolean;
}

/** Every plan rule the registry holds, read from chain rather than from the index. */
export async function GET() {
  try {
    const registry = planRegistryAddress();
    const ids = await readContract<string[]>({
      address: registry,
      functionName: 'list_plan_ids',
    });

    const rules = await Promise.all(
      ids.map(async (planId) => {
        const rule = await readContract<ChainRule>({
          address: registry,
          functionName: 'rule_for',
          args: [planId],
        });
        return rule;
      }),
    );

    const stats = await readContract<Record<string, number | string>>({
      address: registry,
      functionName: 'registry_stats',
    });

    return Response.json({ rules, stats, registry });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'The registry could not be read.' },
      { status: 502 },
    );
  }
}
