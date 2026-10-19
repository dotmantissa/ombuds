/**
 * The Ombuds search index.
 *
 * Neon Postgres, and deliberately not the source of truth. The chain holds every verdict,
 * every case status and every figure that decides whether money moves. This database holds
 * a copy so that search, filtering and "show me my cases" are fast and cheap.
 *
 * The index cannot invent or alter a verdict. Nothing here feeds a payout decision, and
 * every verdict is re-read from OmbudsCourt before the app presents it as fact. If a row
 * here ever disagrees with the chain, the chain is right and the row is stale.
 *
 * Server only. Every query goes through the tagged template, so user input is always a
 * bound parameter and never concatenated into SQL.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';

import { requireEnv } from './env';
import type {
  CaseStatus,
  Citation,
  DocketRow,
  DocketStats,
  Ground,
  PoolEventKind,
} from '@/types/ombuds';
import { GROUNDS, isCaseStatus, isGround } from '@/types/ombuds';

if (typeof window !== 'undefined') {
  throw new Error('web/lib/db.ts is server only and must never be imported by a client component');
}

type SqlClient = ReturnType<typeof neon>;

let cached: SqlClient | null = null;

/** The Neon tagged template. Lazy so a build does not need a database. */
export function sql(): SqlClient {
  if (cached === null) {
    cached = neon(requireEnv('DATABASE_URL'));
  }
  return cached;
}

/* ------------------------------------------------------------------ migration */

let migrated = false;

/**
 * Apply schema.sql. Every statement is IF NOT EXISTS, so this is safe to call on every
 * cold start and is how the index gets created in the first place.
 */
export async function migrate(): Promise<{ applied: number }> {
  if (migrated) return { applied: 0 };

  const file = path.join(process.cwd(), 'lib', 'schema.sql');
  const text = await readFile(file, 'utf8');

  // Split on semicolons that end a statement, dropping comment only fragments.
  const statements = text
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.split(/\r?\n/).every((line) => line.trim().startsWith('--')));

  const client = sql();
  let applied = 0;
  for (const statement of statements) {
    await client.query(statement);
    applied += 1;
  }
  migrated = true;
  return { applied };
}

/* ------------------------------------------------------------------ helpers */

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim() !== '') return BigInt(value.trim());
  return 0n;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(0).toISOString();
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
}

function asStatus(value: unknown): CaseStatus {
  const text = String(value ?? '');
  return isCaseStatus(text) ? text : 'FILED';
}

function asGround(value: unknown): Ground | null {
  const text = String(value ?? '');
  return isGround(text) ? text : null;
}

/* ------------------------------------------------------------------ members */

export interface MemberRow {
  id: string;
  privy_did: string;
  email_hash: string;
  created_at: string;
}

/** Recognise a returning member, or record a new one. Never stores an email address. */
export async function upsertMember(privyDid: string, emailHash: string): Promise<MemberRow> {
  await migrate();
  const rows = (await sql()`
    INSERT INTO members (privy_did, email_hash)
    VALUES (${privyDid}, ${emailHash})
    ON CONFLICT (privy_did) DO UPDATE
      SET last_seen_at = now(),
          email_hash   = EXCLUDED.email_hash
    RETURNING id, privy_did, email_hash, created_at
  `) as Record<string, unknown>[];

  const row = rows[0];
  if (row === undefined) throw new Error('Could not record that member.');
  return {
    id: String(row.id),
    privy_did: String(row.privy_did),
    email_hash: String(row.email_hash),
    created_at: toIso(row.created_at),
  };
}

/* ------------------------------------------------------------------ cases */

export interface InsertCaseInput {
  docket: string;
  memberId: string | null;
  planId: string;
  familyId: string;
  state: string;
  cptCodes: string[];
  icd10Codes: string[];
  denialReasonCode: string;
  denialRationale: string;
  serviceMonth: string;
  disputedAmountAtto: bigint;
  evidenceSha256: string;
  chainTx: string | null;
  status: CaseStatus;
}

export async function insertCase(input: InsertCaseInput): Promise<void> {
  await migrate();
  await sql()`
    INSERT INTO cases (
      docket, member_id, plan_id, family_id, state,
      cpt_codes, icd10_codes, denial_reason_code, denial_rationale,
      service_month, disputed_amount_atto, evidence_sha256, chain_tx, status
    ) VALUES (
      ${input.docket}, ${input.memberId}, ${input.planId}, ${input.familyId}, ${input.state},
      ${input.cptCodes}, ${input.icd10Codes}, ${input.denialReasonCode}, ${input.denialRationale},
      ${input.serviceMonth}, ${input.disputedAmountAtto.toString()}, ${input.evidenceSha256},
      ${input.chainTx}, ${input.status}
    )
    ON CONFLICT (docket) DO UPDATE
      SET status = EXCLUDED.status,
          chain_tx = COALESCE(EXCLUDED.chain_tx, cases.chain_tx),
          updated_at = now()
  `;
}

export async function updateCaseStatus(
  docket: string,
  status: CaseStatus,
  chainTx: string | null = null,
): Promise<void> {
  await migrate();
  await sql()`
    UPDATE cases
       SET status = ${status},
           chain_tx = COALESCE(${chainTx}, chain_tx),
           updated_at = now()
     WHERE docket = ${docket}
  `;
}

function mapDocketRow(row: Record<string, unknown>): DocketRow {
  return {
    docket: String(row.docket),
    filed_at: toIso(row.filed_at),
    status: asStatus(row.status),
    state: String(row.state ?? ''),
    plan_id: String(row.plan_id ?? ''),
    family_id: row.family_id === null || row.family_id === undefined ? null : String(row.family_id),
    cpt_codes: toStringArray(row.cpt_codes),
    icd10_codes: toStringArray(row.icd10_codes),
    disputed_amount_atto: toBigInt(row.disputed_amount_atto),
    recoverable_band:
      row.recoverable_band === null || row.recoverable_band === undefined
        ? null
        : Number(row.recoverable_band),
    ground: asGround(row.ground),
    overturn_recommended:
      row.overturn_recommended === null || row.overturn_recommended === undefined
        ? null
        : Boolean(row.overturn_recommended),
    confidence:
      row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    chain_tx: row.chain_tx === null || row.chain_tx === undefined ? null : String(row.chain_tx),
  };
}

const DOCKET_SELECT = `
  SELECT c.docket, c.filed_at, c.status, c.state, c.plan_id, c.family_id,
         c.cpt_codes, c.icd10_codes, c.disputed_amount_atto, c.chain_tx,
         v.recoverable_band, v.ground, v.overturn_recommended, v.confidence
    FROM cases c
    LEFT JOIN verdicts v ON v.docket = c.docket
`;

export async function getCaseByDocket(docket: string): Promise<DocketRow | null> {
  await migrate();
  const rows = (await sql().query(`${DOCKET_SELECT} WHERE c.docket = $1`, [
    docket,
  ])) as Record<string, unknown>[];
  const row = rows[0];
  return row === undefined ? null : mapDocketRow(row);
}

export async function listCasesForMember(memberId: string, limit = 50): Promise<DocketRow[]> {
  await migrate();
  const rows = (await sql().query(
    `${DOCKET_SELECT} WHERE c.member_id = $1 ORDER BY c.filed_at DESC LIMIT $2`,
    [memberId, Math.min(Math.max(limit, 1), 200)],
  )) as Record<string, unknown>[];
  return rows.map(mapDocketRow);
}

export async function listPublicDocket(limit = 25, offset = 0): Promise<DocketRow[]> {
  await migrate();
  const rows = (await sql().query(
    `${DOCKET_SELECT} ORDER BY c.filed_at DESC LIMIT $1 OFFSET $2`,
    [Math.min(Math.max(limit, 1), 100), Math.max(offset, 0)],
  )) as Record<string, unknown>[];
  return rows.map(mapDocketRow);
}

/** Free text search across the things a person would actually remember. */
export async function searchCases(q: string, limit = 25): Promise<DocketRow[]> {
  await migrate();
  const needle = `%${q.trim().toLowerCase()}%`;
  const rows = (await sql().query(
    `${DOCKET_SELECT}
      WHERE lower(c.docket) LIKE $1
         OR lower(c.plan_id) LIKE $1
         OR lower(c.family_id) LIKE $1
         OR lower(c.denial_reason_code) LIKE $1
         OR lower(c.denial_rationale) LIKE $1
         OR EXISTS (SELECT 1 FROM unnest(c.cpt_codes) code WHERE lower(code) LIKE $1)
         OR EXISTS (SELECT 1 FROM unnest(c.icd10_codes) code WHERE lower(code) LIKE $1)
      ORDER BY c.filed_at DESC
      LIMIT $2`,
    [needle, Math.min(Math.max(limit, 1), 100)],
  )) as Record<string, unknown>[];
  return rows.map(mapDocketRow);
}

/* ------------------------------------------------------------------ verdicts */

export interface RecordVerdictInput {
  docket: string;
  overturnRecommended: boolean;
  ground: string;
  clauseId: string;
  clauseSection: string;
  clauseQuote: string;
  recoverableBand: number;
  confidence: number;
  digest: string;
  citations: Citation[] | unknown[];
  reasoning: string;
  txHash: string | null;
  panelRound: number;
}

export async function recordVerdict(input: RecordVerdictInput): Promise<void> {
  await migrate();
  await sql()`
    INSERT INTO verdicts (
      docket, overturn_recommended, ground, clause_id, clause_section, clause_quote,
      recoverable_band, confidence, digest, citations, reasoning, tx_hash, panel_round
    ) VALUES (
      ${input.docket}, ${input.overturnRecommended}, ${input.ground}, ${input.clauseId},
      ${input.clauseSection}, ${input.clauseQuote}, ${input.recoverableBand},
      ${input.confidence}, ${input.digest}, ${JSON.stringify(input.citations)},
      ${input.reasoning}, ${input.txHash}, ${input.panelRound}
    )
    ON CONFLICT (docket) DO UPDATE SET
      overturn_recommended = EXCLUDED.overturn_recommended,
      ground               = EXCLUDED.ground,
      clause_id            = EXCLUDED.clause_id,
      clause_section       = EXCLUDED.clause_section,
      clause_quote         = EXCLUDED.clause_quote,
      recoverable_band     = EXCLUDED.recoverable_band,
      confidence           = EXCLUDED.confidence,
      digest               = EXCLUDED.digest,
      citations            = EXCLUDED.citations,
      reasoning            = EXCLUDED.reasoning,
      tx_hash              = EXCLUDED.tx_hash,
      panel_round          = EXCLUDED.panel_round,
      adjudicated_at       = now()
  `;
}

/* ------------------------------------------------------------------ pool + sources */

export async function recordPoolEvent(input: {
  kind: PoolEventKind;
  actor: string;
  amountAtto: bigint;
  docket: string | null;
  txHash: string | null;
}): Promise<void> {
  await migrate();
  await sql()`
    INSERT INTO pool_events (kind, actor, amount_atto, docket, tx_hash)
    VALUES (${input.kind}, ${input.actor}, ${input.amountAtto.toString()}, ${input.docket}, ${input.txHash})
  `;
}

export async function listPoolEvents(limit = 25): Promise<
  Array<{
    id: string;
    kind: PoolEventKind;
    actor: string;
    amount_atto: bigint;
    docket: string | null;
    tx_hash: string | null;
    at: string;
  }>
> {
  await migrate();
  const rows = (await sql()`
    SELECT id, kind, actor, amount_atto, docket, tx_hash, at
      FROM pool_events
     ORDER BY at DESC
     LIMIT ${Math.min(Math.max(limit, 1), 100)}
  `) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind) as PoolEventKind,
    actor: String(row.actor ?? ''),
    amount_atto: toBigInt(row.amount_atto),
    docket: row.docket === null || row.docket === undefined ? null : String(row.docket),
    tx_hash: row.tx_hash === null || row.tx_hash === undefined ? null : String(row.tx_hash),
    at: toIso(row.at),
  }));
}

export async function recordSourceSnapshot(input: {
  docket: string | null;
  url: string;
  kind: string;
  contentSha256: string;
}): Promise<void> {
  await migrate();
  await sql()`
    INSERT INTO source_snapshots (docket, url, kind, content_sha256)
    VALUES (${input.docket}, ${input.url}, ${input.kind}, ${input.contentSha256})
  `;
}

/* ------------------------------------------------------------------ stats */

export async function docketStats(): Promise<DocketStats> {
  await migrate();
  const client = sql();

  const totals = (await client`
    SELECT count(*)::int AS total,
           COALESCE(sum(disputed_amount_atto), 0)::text AS disputed
      FROM cases
  `) as Record<string, unknown>[];

  const decided = (await client`
    SELECT
      count(*) FILTER (WHERE overturn_recommended)::int      AS overturned,
      count(*) FILTER (WHERE NOT overturn_recommended)::int  AS upheld
      FROM verdicts
  `) as Record<string, unknown>[];

  const grounds = (await client`
    SELECT ground, count(*)::int AS n FROM verdicts GROUP BY ground
  `) as Record<string, unknown>[];

  const total = Number(totals[0]?.total ?? 0);
  const overturned = Number(decided[0]?.overturned ?? 0);
  const upheld = Number(decided[0]?.upheld ?? 0);
  const judged = overturned + upheld;

  const byGround = {} as Record<Ground, number>;
  for (const ground of GROUNDS) byGround[ground] = 0;
  for (const row of grounds) {
    const ground = asGround(row.ground);
    if (ground !== null) byGround[ground] = Number(row.n ?? 0);
  }

  return {
    total_cases: total,
    overturn_recommended: overturned,
    denial_upheld: upheld,
    awaiting_verdict: total - judged > 0 ? total - judged : 0,
    overturn_rate_bps: judged > 0 ? Math.round((overturned / judged) * 10000) : 0,
    total_disputed_atto: toBigInt(totals[0]?.disputed),
    by_ground: byGround,
  };
}

/** A cheap liveness probe for the index. Never throws, so a page can degrade gracefully. */
export async function indexHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    await migrate();
    await sql()`SELECT 1`;
    return { ok: true, detail: 'The index is up.' };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : 'The index could not be reached.',
    };
  }
}

/** Sponsorship is limited to the authenticated owner of the indexed case. */
export async function memberOwnsCase(memberId: string, docket: string): Promise<boolean> {
  await migrate();
  const rows = await sql()`SELECT docket FROM cases WHERE member_id = ${memberId} AND docket = ${docket}`;
  return Array.isArray(rows) && rows.length > 0;
}
