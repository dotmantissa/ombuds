/** Display helpers for authoritative chain records. Money stays integer-scaled. */
export interface Page<T> { total: number; items: T[]; offset?: number }
export interface ProtocolEvent { id?: number; sequence?: number; kind: string; at: string;
  actor: string; docket?: string; amount_atto?: string; reference?: string; details?: Record<string, unknown> }
export interface Payout { id: string; kind: string; recipient: string; amount_atto: string;
  docket: string; status: 'PENDING' | 'REFUNDED' | 'ACKNOWLEDGED'; attempt: number; updated_at: string }
export interface RoundVerdict { docket: string; panel_round: number; digest: string; ruling_digest: string;
  overturn_recommended: boolean; ground: string; clause_id: string; clause_section: string;
  clause_quote: string; recoverable_band: number; confidence: number; crosses_confidence_band: boolean;
  reasoning: string; adjudicated_at: string; bulletin_digest: string; cms_digest: string;
  citations: Array<{ url?: string; title?: string; locator?: string; digest?: string }>;
  provenance: { evidence_sha256: string; sha256: string; record_sha256: string; registry: string;
    policy: { policy_version?: number; policy_digest?: string; plan_id: string; effective_from: string;
      effective_to: string; bulletin_url: string; cms_source_url: string } } }
export function formatGen(value: string | undefined, precision = 4): string {
  if (value === undefined) return 'Unavailable';
  try {
    const amount = BigInt(value); const unit = 10n ** 18n;
    const fraction = ((amount % unit) * 10n ** BigInt(precision) / unit).toString().padStart(precision, '0');
    if (amount > 0n && amount < unit / 10n ** BigInt(precision)) return `<0.${'0'.repeat(precision - 1)}1 GEN`;
    return `${amount / unit}.${fraction} GEN`;
  } catch { return 'Unavailable'; }
}
export function verdictChanges(before: RoundVerdict, after: RoundVerdict) {
  const fields = [
    ['Recommendation', before.overturn_recommended ? 'Overturn' : 'Uphold', after.overturn_recommended ? 'Overturn' : 'Uphold'],
    ['Ground', before.ground, after.ground], ['Clause', before.clause_id, after.clause_id],
    ['Payout band', String(before.recoverable_band), String(after.recoverable_band)],
    ['Clears payout threshold', String(before.crosses_confidence_band), String(after.crosses_confidence_band)],
    ['Policy version', String(before.provenance?.policy?.policy_version ?? 'Unversioned'), String(after.provenance?.policy?.policy_version ?? 'Unversioned')],
    ['Policy configuration', before.provenance?.policy?.policy_digest, after.provenance?.policy?.policy_digest],
    ['Policy document', before.bulletin_digest, after.bulletin_digest],
    ['Submitted evidence', before.provenance?.evidence_sha256, after.provenance?.evidence_sha256],
    ['Sanitized case record', before.provenance?.record_sha256, after.provenance?.record_sha256],
  ];
  return fields.filter(([, a, b]) => a !== b).map(([label, before, after]) => ({ label, before: before ?? '', after: after ?? '' }));
}
export function pageNumber(raw: string | null | undefined, fallback = 0, maximum = 100_000) {
  const value = raw == null ? fallback : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : fallback;
}
export const PAYMENT_LABELS: Record<string, string> = {
  PENDING: 'Emitted · delivery unverified', REFUNDED: 'Funds returned · ready for retry',
  ACKNOWLEDGED: 'Receipt acknowledged by recipient',
};
