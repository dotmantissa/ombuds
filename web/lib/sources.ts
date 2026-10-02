/**
 * Reading data/sources.json, wherever it has ended up.
 *
 * There is one copy of this dataset and it lives at web/data/sources.json. The seed script
 * and the source verifier both reach in here for it, so the chain and the app can never
 * disagree about which sources exist.
 *
 * It is read at request time rather than imported, because the verifier rewrites it and a
 * bundled import would freeze whatever was true at build time. That means the bundler cannot
 * see it, so next.config.ts names it in `outputFileTracingIncludes`. The working directory of
 * a serverless function is also not the working directory of `next dev`, hence the short
 * candidate list rather than one hard coded path.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Verification {
  http_status: number | string;
  bytes: number;
  content_type: string;
  observed_at: string;
  reachable: boolean;
}

export interface SourceStateRow {
  state: string;
  state_name: string;
  agency: string;
  statute_citation: string;
  external_review_deadline_days: number;
  internal_appeal_deadline_days?: number;
  mechanism: string;
  statute_url: string;
  agency_url: string;
  follows_federal_default: boolean;
  verification?: { statute_url: Verification; agency_url: Verification };
}

export interface ReasonCode {
  code: string;
  set: string;
  description: string;
  maps_to_ground: string;
}

export interface SourceFamily {
  family_id: string;
  label: string;
  plain_language: string;
  cpt_codes: Array<{ code: string; description: string }>;
  icd10_codes: Array<{ code: string; description: string }>;
  ncd:
    | null
    | {
        display_id: string;
        ncdid: number;
        ver: number;
        title?: string;
        api_url: string;
        effective_date?: string;
        verification?: Verification;
      };
  secondary_ncd?: { display_id: string; api_url: string; verification?: Verification };
  guideline?: { body: string; title: string; url: string; verification?: Verification };
}

export interface SourceDataset {
  meta: {
    generated_at: string;
    generator: string;
    verification_method: string;
    fetchable_on_chain_note: string;
    rejected: Array<{ source: string; url: string; reason: string }>;
  };
  federal_external_review: {
    rule: string;
    citation: string;
    default_request_window_days: number;
    url: string;
  };
  code_set_authorities: Array<{ set: string; steward: string; url: string }>;
  procedure_families: SourceFamily[];
  plan_rules: Array<Record<string, unknown>>;
  states: SourceStateRow[];
  denial_reason_codes: ReasonCode[];
}

/** Where the file sits, allowing for the fact that a function's cwd is not always the root. */
function candidates(): string[] {
  const cwd = process.cwd();
  return [
    path.join(cwd, 'data', 'sources.json'),
    // A Vercel function mounts its traced files under the task root, which is not the cwd.
    path.join('/var/task', 'data', 'sources.json'),
    path.join(cwd, 'web', 'data', 'sources.json'),
  ];
}

let cached: SourceDataset | null = null;
let cachedPath: string | null = null;

/** The dataset, or null when it genuinely cannot be found. Never throws. */
export async function loadSources(): Promise<SourceDataset | null> {
  if (cached !== null) return cached;

  const tried: string[] = [];
  for (const candidate of candidates()) {
    try {
      const text = await readFile(candidate, 'utf8');
      cached = JSON.parse(text) as SourceDataset;
      cachedPath = candidate;
      return cached;
    } catch {
      tried.push(candidate);
    }
  }
  // Worth one line in the log, because a missing dataset degrades real pages.
  console.warn(`[sources] could not read data/sources.json. Tried: ${tried.join(', ')}`);
  return null;
}

/** Where the dataset was actually read from. Handy when a deploy behaves oddly. */
export function sourcesPath(): string | null {
  return cachedPath;
}

export async function statesList(): Promise<SourceStateRow[]> {
  return (await loadSources())?.states ?? [];
}

export async function reasonCodes(): Promise<ReasonCode[]> {
  return (await loadSources())?.denial_reason_codes ?? [];
}

export async function stateFor(code: string): Promise<SourceStateRow | null> {
  const states = await statesList();
  return states.find((row) => row.state === code) ?? null;
}
