/**
 * Shared Ombuds types.
 *
 * These are the shapes that travel between the chain, the index and the UI. The
 * verdict fields marked consensus critical have to match exactly across
 * validators, so they are narrow unions rather than open strings.
 *
 * Safe to import from anywhere, client or server. Nothing in here touches the
 * environment or the network.
 */

/* ---------------------------------------------------------------------------
   Ground
   --------------------------------------------------------------------------- */

/**
 * The five grounds a verdict can rest on. This is consensus critical: every
 * validator has to land on the same value, so the enum is closed and the
 * strings are the exact on chain values.
 */
export type Ground =
  | 'MEDICAL_NECESSITY'
  | 'CODING_ERROR'
  | 'NETWORK_STATUS'
  | 'PRIOR_AUTH_DEFECT'
  | 'TIMELINESS';

/** Ordered for display. Same order the contract enumerates them in. */
export const GROUNDS: readonly Ground[] = [
  'MEDICAL_NECESSITY',
  'CODING_ERROR',
  'NETWORK_STATUS',
  'PRIOR_AUTH_DEFECT',
  'TIMELINESS',
] as const;

/** Human readable, sentence case, no hyphens. */
export const GROUND_LABELS: Readonly<Record<Ground, string>> = {
  MEDICAL_NECESSITY: 'Medical necessity',
  CODING_ERROR: 'Coding error',
  NETWORK_STATUS: 'Network status',
  PRIOR_AUTH_DEFECT: 'Prior authorisation defect',
  TIMELINESS: 'Timeliness',
} as const;

/** A one line plain English gloss of what each ground actually means. */
export const GROUND_DESCRIPTIONS: Readonly<Record<Ground, string>> = {
  MEDICAL_NECESSITY:
    'The plan says the service was not medically necessary, and its own published rule says otherwise.',
  CODING_ERROR:
    'The claim was denied on a code that does not match the service that was actually delivered.',
  NETWORK_STATUS:
    'The provider was treated as out of network when the plan documents put them in network.',
  PRIOR_AUTH_DEFECT:
    'Prior authorisation was either not required, or it was granted and then ignored.',
  TIMELINESS:
    'The claim or the appeal was treated as late when the plan clock says it was not.',
} as const;

export function isGround(value: string): value is Ground {
  return (GROUNDS as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------------------
   Case status
   --------------------------------------------------------------------------- */

/**
 * Where a case sits in its life. FILED and ADJUDICATING are chain states,
 * VERDICT means a verdict object exists, ADVANCED means the pool has paid the
 * member, UNDER_REVIEW means somebody posted a bond and a fresh panel is
 * looking at it again, SETTLED means the insurer paid, REJECTED means the case
 * never got off the ground, usually a lapsed plan rule.
 */
export type CaseStatus =
  | 'FILED'
  | 'ADJUDICATING'
  | 'VERDICT'
  | 'ADVANCED'
  | 'UNDER_REVIEW'
  | 'SETTLED'
  | 'REJECTED';

export const CASE_STATUSES: readonly CaseStatus[] = [
  'FILED',
  'ADJUDICATING',
  'VERDICT',
  'ADVANCED',
  'UNDER_REVIEW',
  'SETTLED',
  'REJECTED',
] as const;

/** Human readable, sentence case, no hyphens. */
export const CASE_STATUS_LABELS: Readonly<Record<CaseStatus, string>> = {
  FILED: 'Filed',
  ADJUDICATING: 'Adjudicating',
  VERDICT: 'Verdict in',
  ADVANCED: 'Advanced',
  UNDER_REVIEW: 'Under review',
  SETTLED: 'Settled',
  REJECTED: 'Rejected',
} as const;

export function isCaseStatus(value: string): value is CaseStatus {
  return (CASE_STATUSES as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------------------
   Sources and citations
   --------------------------------------------------------------------------- */

/** Where a cited document came from. */
export type SourceKind =
  | 'PLAN_BULLETIN'
  | 'CMS_NCD'
  | 'STATE_STATUTE'
  | 'SBC'
  | 'OTHER';

/**
 * One source tied to one claim in a verdict. `clause_id` is the anti
 * hallucination clamp: the clause has to exist in the document at `url`, and a
 * validator can check it because the document gets re-fetched.
 */
export interface Citation {
  /** The cited clause identifier, exactly as it appears in the document. */
  clause_id: string;
  /** The public URL the clause was read from. */
  url: string;
  /** The verbatim clause text, quoted so a reader can check it themselves. */
  quote: string;
  /** SHA-256 of the fetched document, so a silent edit becomes visible. */
  content_sha256: string | null;
  kind: SourceKind;
  /** ISO timestamp of the fetch, or null if the snapshot is not recorded yet. */
  fetched_at: string | null;
}

/**
 * A plan rule as PlanRegistry holds it. Rules expire, and adjudicating against
 * a lapsed rule is rejected rather than guessed at.
 */
export interface PlanRule {
  plan_id: string;
  /** The plan family, for grouping bulletins that share a parent policy. */
  family_id: string;
  bulletin_url: string;
  sbc_hash: string | null;
  /** Two letter state code. */
  state: string;
  /** ISO date. */
  effective_from: string;
  /** ISO date, or null for a rule with no published end. */
  effective_to: string | null;
  cms_ncd_id: string | null;
  cms_ncd_ver: string | null;
  /** Hash of the fetched bulletin. A bump here means the policy moved. */
  content_hash: string;
}

/* ---------------------------------------------------------------------------
   The de-identified case record
   --------------------------------------------------------------------------- */

/**
 * The de-identified case record. This is the ONLY case shaped thing that is
 * allowed to reach the chain.
 *
 * Prompts are public on GenLayer, so anything in here is effectively published.
 * No name, no member id, no date of birth, no raw denial letter. The service
 * date is bucketed to a month and the original document survives only as a
 * SHA-256 hash. `deident.ts` builds this and refuses to return one that still
 * matches a Safe Harbor pattern.
 */
export interface CaseRecord {
  plan_id: string;
  family_id: string;
  /** Two letter state code. Drives which insurance statute applies. */
  state: string;
  /** Candidate CPT and HCPCS codes, de-duplicated and sorted. */
  cpt_codes: string[];
  /** Candidate ICD-10-CM codes, de-duplicated and sorted. */
  icd10_codes: string[];
  /** The insurer's own denial reason code. */
  denial_reason_code: string;
  /** The verbatim denial rationale sentence, scrubbed of identifiers. */
  denial_rationale: string;
  /** Service date bucketed to YYYY-MM. Never a full date. */
  service_month: string;
  /** Disputed amount in atto scale, which is USD times 10 to the 18th. */
  disputed_amount_atto: bigint;
  /** SHA-256 of the original document. The document itself never leaves. */
  evidence_sha256: string;
  /** Public source URLs a validator will re-fetch. */
  source_urls: string[];
}

/* ---------------------------------------------------------------------------
   Verdict
   --------------------------------------------------------------------------- */

/**
 * A verdict as the court writes it.
 *
 * `overturn_recommended`, `ground`, `clause_id` and `recoverable_band` are the
 * consensus critical fields: validators each re-fetch the sources, re-derive
 * the verdict and have to agree on these four exactly before anything is
 * written. `confidence` and `reasoning` are the leader's, not the panel's.
 */
export interface Verdict {
  docket: string;
  /** Consensus critical. Must match exactly across validators. */
  overturn_recommended: boolean;
  /** Consensus critical. One of the five grounds. */
  ground: Ground;
  /** Consensus critical. The cited bulletin clause identifier. */
  clause_id: string;
  /** Consensus critical. A discrete payout band, never a continuous number. */
  recoverable_band: number;
  /** 0 to 100. Drives whether the pool advances. */
  confidence: number;
  /** Digest over the consensus critical fields. */
  digest: string;
  citations: Citation[];
  /** The leader's written reasoning. Never medical advice, only coverage. */
  reasoning: string;
  tx_hash: string | null;
  /** ISO timestamp. */
  adjudicated_at: string | null;
}

/* ---------------------------------------------------------------------------
   Pool
   --------------------------------------------------------------------------- */

/** What kind of thing happened in the advance pool. */
export type PoolEventKind =
  | 'DEPOSIT'
  | 'WITHDRAW'
  | 'ADVANCE'
  | 'RECOVERY'
  | 'WRITE_OFF';

/**
 * Pool headline numbers. The escrowed capital is the Total Value Governed, so
 * `total_value_governed_atto` is the number that matters most on the pool page.
 */
export interface PoolStats {
  /** Escrowed capital under the pool's control. This is the TVG. */
  total_value_governed_atto: bigint;
  /** Capital sitting idle and available to advance. */
  available_atto: bigint;
  /** Capital currently out with members, waiting on an insurer. */
  advanced_atto: bigint;
  /** Capital an insurer has since paid back. */
  recovered_atto: bigint;
  underwriter_count: number;
  advance_count: number;
  /** Recovered over advanced, in basis points. */
  recovery_rate_bps: number;
}

/* ---------------------------------------------------------------------------
   Docket
   --------------------------------------------------------------------------- */

/**
 * One row of the public docket. Flat on purpose: it is what a list renders, so
 * a case and its verdict are joined into a single object.
 *
 * This comes out of the index, which is NOT authoritative. Before a verdict is
 * shown as fact it gets re-read from chain.
 */
export interface DocketRow {
  docket: string;
  /** ISO timestamp. */
  filed_at: string;
  status: CaseStatus;
  /** Two letter state code. */
  state: string;
  plan_id: string;
  family_id: string | null;
  cpt_codes: string[];
  icd10_codes: string[];
  disputed_amount_atto: bigint;
  /** Null until a verdict exists. */
  recoverable_band: number | null;
  ground: Ground | null;
  overturn_recommended: boolean | null;
  confidence: number | null;
  /** The chain transaction that carries the verdict. */
  chain_tx: string | null;
}

/** Headline counts for the docket page. */
export interface DocketStats {
  total_cases: number;
  overturn_recommended: number;
  denial_upheld: number;
  awaiting_verdict: number;
  /** Overturns over decided cases, in basis points. */
  overturn_rate_bps: number;
  total_disputed_atto: bigint;
  by_ground: Readonly<Record<Ground, number>>;
}
