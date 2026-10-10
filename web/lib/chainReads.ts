/**
 * Server side chain reads for pages.
 *
 * Every one of these degrades to null rather than throwing. A page that cannot reach the
 * studio endpoint should still render its argument and say the numbers are unavailable,
 * because the argument does not depend on the numbers being live this second.
 */

import {
  advancePoolAddress,
  ombudsCourtAddress,
  planRegistryAddress,
  readContract,
} from './genlayer';

export interface ChainRule {
  plan_id: string;
  insurer: string;
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
  active: boolean;
  retired: boolean;
}

export interface CourtStats {
  case_count: number;
  verdict_count: number;
  overturn_count: number;
  review_count: number;
  total_disputed_atto: string;
  total_overturned_atto: string;
  grounds: Record<string, number>;
  statuses: Record<string, number>;
}

export interface PoolStats {
  total_value_governed_atto: string;
  free_capital_atto: string;
  outstanding_atto: string;
  total_advanced_atto: string;
  total_recovered_atto: string;
  total_fees_atto: string;
  total_written_off_atto: string;
  advance_count: number;
  underwriter_count: number;
  utilisation_bps: number;
}

/** One underwriter's position, as the pool reports it. */
export interface PoolPosition {
  address: string;
  principal_atto: string;
  active_principal_atto: string;
  withdrawn_atto: string;
  fees_earned_atto: string;
  /** This position's share of every loss the pool has booked. */
  loss_borne_atto: string;
  /** What this position may actually take out, after fees and after losses. */
  withdrawable_atto: string;
  deposit_count: number;
  share_bps: number;
  first_deposit_at: string;
  last_deposit_at: string;
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export function registryStats() {
  return attempt(() =>
    readContract<{
      rule_count: number;
      active_count: number;
      total_refreshes: number;
      total_revisions: number;
    }>({ address: planRegistryAddress(), functionName: 'registry_stats' }),
  );
}

export function courtStats() {
  return attempt(() =>
    readContract<CourtStats>({ address: ombudsCourtAddress(), functionName: 'court_stats' }),
  );
}

export function poolStats() {
  return attempt(() =>
    readContract<PoolStats>({ address: advancePoolAddress(), functionName: 'pool_stats' }),
  );
}

export function poolConfig() {
  return attempt(() =>
    readContract<{
      advance_rate_bps: number;
      fee_bps: number;
      max_utilisation_bps: number;
      band_caps_atto: string[];
      court: string;
    }>({ address: advancePoolAddress(), functionName: 'get_config' }),
  );
}

export function courtConfig() {
  return attempt(() =>
    readContract<{
      min_confidence: number;
      review_bond_atto: string;
      grounds: string[];
      band_upper_usd: number[];
      registry: string;
      pool: string;
    }>({ address: ombudsCourtAddress(), functionName: 'get_config' }),
  );
}

export async function planRules(): Promise<ChainRule[]> {
  const registry = await attempt(() => Promise.resolve(planRegistryAddress()));
  if (registry === null) return [];
  const ids = await attempt(() =>
    readContract<string[]>({ address: registry, functionName: 'list_plan_ids' }),
  );
  if (ids === null) return [];
  const rules = await Promise.all(
    ids.map((planId) =>
      attempt(() =>
        readContract<ChainRule>({ address: registry, functionName: 'rule_for', args: [planId] }),
      ),
    ),
  );
  return rules.filter((rule): rule is ChainRule => rule !== null);
}

export function docketPage(offset = 0, limit = 20) {
  return attempt(() =>
    readContract<
      Array<{
        docket: string;
        plan_id: string;
        family_id: string;
        state: string;
        status: string;
        filed_at: string;
        disputed_atto: string;
        overturn_recommended: boolean;
        ground: string;
        recoverable_band: number;
        confidence: number;
      }>
    >({ address: ombudsCourtAddress(), functionName: 'docket_page', args: [offset, limit] }),
  );
}

export function advanceLedger(limit = 25) {
  return attempt(() =>
    readContract<
      Array<{
        docket: string;
        member: string;
        amount_atto: string;
        band: number;
        status: string;
        made_at: string;
        recovered_atto: string;
      }>
    >({ address: advancePoolAddress(), functionName: 'advance_ledger', args: [limit] }),
  );
}

export function caseOnChain(docket: string) {
  return attempt(() =>
    readContract<Record<string, unknown>>({
      address: ombudsCourtAddress(),
      functionName: 'get_case',
      args: [docket],
    }),
  );
}

export function verdictOnChain(docket: string) {
  return attempt(() =>
    readContract<Record<string, unknown>>({
      address: ombudsCourtAddress(),
      functionName: 'get_verdict',
      args: [docket],
    }),
  );
}

export function advanceabilityOnChain(docket: string) {
  return attempt(() =>
    readContract<{ ok: boolean; reason: string; band: number }>({
      address: ombudsCourtAddress(),
      functionName: 'is_advanceable',
      args: [docket],
    }),
  );
}

export function quoteAdvance(docket: string) {
  return attempt(() =>
    readContract<{
      eligible: boolean;
      reason: string;
      amount_atto: string;
      limited_by?: string;
      band?: number;
    }>({ address: advancePoolAddress(), functionName: 'quote_advance', args: [docket] }),
  );
}
