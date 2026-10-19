/**
 * The filing API path, end to end, with no network.
 *
 * This drives the real handler. Auth, body validation, the evidence commitment, the
 * de-identification, the member binding, the arguments handed to `file_case`, the index
 * write and every refusal in between are the production code paths; only the four
 * collaborators that need a key, a database or a chain are replaced.
 *
 * The argument worth watching is the last one in the `file_case` call. That is the
 * address the court records as the filer, which is the address the pool pays an advance
 * to and the court pays a bond to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCaseRecord, sha256Hex } from '@/lib/deident';
import {
  fileCase,
  listFiledCases,
  type FilingDeps,
} from '@/lib/filing';
import { AuthError, type AuthenticatedMember } from '@/lib/privy';
import { ReceiptTimeoutError } from '@/lib/genlayer';
import type { TransactionHash } from 'genlayer-js/types';
import type { DocketRow } from '@/types/ombuds';

const COURT = '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0' as const;
const TX_HASH = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' as unknown as TransactionHash;
const TIMEOUT_TX_HASH = '0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1' as unknown as TransactionHash;
const MEMBER_WALLET = '0x7a3fC4dA91B20eF5C8d1e2A4b6C8D0e2F4a6B8c0';
const NOMINATED = '0x1111111111111111111111111111111111111111';

const LETTER = [
  'Dear Member,',
  '',
  'We have completed our review of the claim submitted on your behalf for CPT 43644',
  'with a diagnosis of E66.01. Benefit denied because the requested procedure is',
  'considered not medically necessary for this member under the applicable clinical',
  'policy. Reason code 50.',
].join('\n');

const RATIONALE =
  'Benefit denied because the requested procedure is considered not medically necessary ' +
  'for this member under the applicable clinical policy.';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planId: 'AETNA-COMMERCIAL-BARIATRIC',
    familyId: 'bariatric_surgery',
    state: 'TX',
    letterText: LETTER,
    denialRationale: RATIONALE,
    denialReasonCode: '50',
    serviceDate: '2026-04-18',
    disputedAmount: '12400',
    sourceUrls: ['https://www.aetna.com/cpb/medical/data/100_199/0157.html'],
    ...overrides,
  };
}

function post(payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://ombuds.test/api/cases', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

const member = (overrides: Partial<AuthenticatedMember> = {}): AuthenticatedMember => ({
  id: 'member-1',
  privy_did: 'did:privy:clxyz0000000000000000000',
  email_hash: 'f'.repeat(64),
  created_at: '2026-01-01T00:00:00.000Z',
  memberAddress: MEMBER_WALLET.toLowerCase(),
  ...overrides,
});

interface Recorded {
  writes: Array<{ address: string; functionName: string; args: unknown[] }>;
  cases: Array<Record<string, unknown>>;
  snapshots: Array<Record<string, unknown>>;
}

/**
 * The real handler with fake edges.
 *
 * `buildCaseRecord` is deliberately NOT faked: the de-identification is the thing that
 * decides what the record contains, and a test that stubs it proves nothing about the
 * evidence path.
 */
function harness(
  overrides: Partial<FilingDeps> = {},
  options: { ok?: boolean; error?: string | null; receipt?: unknown; timeout?: boolean } = {},
): { deps: FilingDeps; recorded: Recorded } {
  const recorded: Recorded = { writes: [], cases: [], snapshots: [] };

  const deps: FilingDeps = {
    requireMember: async () => member(),
    buildCaseRecord,
    courtAddress: () => COURT,
    writeContract: async (params) => {
      recorded.writes.push({
        address: params.address,
        functionName: params.functionName,
        args: params.args ?? [],
      });
      if (options.timeout === true) {
        throw new ReceiptTimeoutError(TIMEOUT_TX_HASH);
      }
      return {
        txHash: TX_HASH,
        receipt: (options.receipt ?? {
          consensus_data: { leader_receipt: [{ result: 'OMB-2026-000042' }] },
        }) as never,
        ok: options.ok ?? true,
        status: 'FINALIZED',
        executionResult: (options.ok ?? true) ? 'FINISHED_WITH_RETURN' : 'FINISHED_WITH_ERROR',
        error: options.error ?? null,
      };
    },
    insertCase: async (input) => {
      recorded.cases.push(input as unknown as Record<string, unknown>);
    },
    recordSourceSnapshot: async (input) => {
      recorded.snapshots.push(input as unknown as Record<string, unknown>);
    },
    listCasesForMember: async () => [],
    ...overrides,
  };

  return { deps, recorded };
}

/** The filer address, which is the last argument of file_case. */
function filerArg(recorded: Recorded): string {
  assert.equal(recorded.writes.length, 1, 'expected exactly one chain write');
  const write = recorded.writes[0];
  assert.ok(write !== undefined);
  assert.equal(write.functionName, 'file_case');
  assert.equal(write.args.length, 11);
  return String(write.args[10]);
}

/* ------------------------------------------------------------------------------- auth */

test('an unauthenticated filing is refused before anything is read', async () => {
  const { deps, recorded } = harness({
    requireMember: async () => {
      throw new AuthError('You need to be signed in to do that.');
    },
  });

  const res = await fileCase(post(body()), deps);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'You need to be signed in to do that.' });
  assert.equal(recorded.writes.length, 0);
  assert.equal(recorded.cases.length, 0);
});

test('an unauthenticated list is refused too', async () => {
  const { deps } = harness({
    requireMember: async () => {
      throw new AuthError('That sign in session is no longer valid. Please sign in again.');
    },
  });
  const res = await listFiledCases(new Request('https://ombuds.test/api/cases'), deps);
  assert.equal(res.status, 401);
});

test('an unverified session reaching the real verifier is refused with no token', async () => {
  // No fake at all here: requireMember is the production function, and a request with no
  // Privy header never gets as far as needing an app secret.
  const res = await fileCase(post(body()));
  assert.equal(res.status, 401);
  const payload = (await res.json()) as { error: string };
  assert.match(payload.error, /signed in/);
});

test('the list only ever asks for this member and stringifies the amounts', async () => {
  const asked: string[] = [];
  const row: DocketRow = {
    docket: 'OMB-2026-000042',
    filed_at: '2026-04-20T00:00:00.000Z',
    status: 'FILED',
    state: 'TX',
    plan_id: 'AETNA-COMMERCIAL-BARIATRIC',
    family_id: 'bariatric_surgery',
    cpt_codes: ['43644'],
    icd10_codes: ['E66.01'],
    disputed_amount_atto: 12_400n * 10n ** 18n,
    recoverable_band: null,
    ground: null,
    overturn_recommended: null,
    confidence: null,
    chain_tx: TX_HASH as unknown as string,
  };
  const { deps } = harness({
    listCasesForMember: async (memberId) => {
      asked.push(memberId);
      return [row];
    },
  });

  const res = await listFiledCases(new Request('https://ombuds.test/api/cases'), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(asked, ['member-1']);
  const payload = (await res.json()) as { cases: Array<{ disputed_amount_atto: string }> };
  assert.equal(payload.cases[0]?.disputed_amount_atto, '12400000000000000000000');
});

/* ------------------------------------------------------------------- the member binding */

test('the court is told the member address, never the relayer', async () => {
  const { deps, recorded } = harness();
  const res = await fileCase(post(body()), deps);

  assert.equal(res.status, 200);
  assert.equal(filerArg(recorded), MEMBER_WALLET.toLowerCase());

  const payload = (await res.json()) as { docket: string; payoutAddress: string };
  assert.equal(payload.docket, 'OMB-2026-000042');
  assert.equal(payload.payoutAddress, MEMBER_WALLET.toLowerCase());
});

test('a nominated payout address is what the court records', async () => {
  const { deps, recorded } = harness();
  const res = await fileCase(post(body({ payoutAddress: NOMINATED })), deps);

  assert.equal(res.status, 200);
  assert.equal(filerArg(recorded), NOMINATED);
});

test('a member with no address is refused before the relayer signs anything', async () => {
  const { deps, recorded } = harness({
    requireMember: async () => member({ memberAddress: null }),
  });

  const res = await fileCase(post(body()), deps);
  assert.equal(res.status, 400);
  const payload = (await res.json()) as { error: string };
  assert.match(payload.error, /do not have an address to pay you at/);
  // The important part: nothing was signed and nothing was indexed.
  assert.equal(recorded.writes.length, 0);
  assert.equal(recorded.cases.length, 0);
});

test('a nonsense payout address is refused before the relayer signs anything', async () => {
  const { deps, recorded } = harness();
  const res = await fileCase(post(body({ payoutAddress: '0xnope' })), deps);
  assert.equal(res.status, 400);
  assert.equal(recorded.writes.length, 0);
});

test('the case row is written against the authenticated member, not the payout address', async () => {
  // The index belongs to the member. The payout address is where money goes and may be
  // somewhere else entirely, so the two must not be conflated.
  const { deps, recorded } = harness();
  await fileCase(post(body({ payoutAddress: NOMINATED })), deps);

  assert.equal(recorded.cases.length, 1);
  assert.equal(recorded.cases[0]?.memberId, 'member-1');
  assert.equal(recorded.cases[0]?.docket, 'OMB-2026-000042');
  assert.equal(recorded.cases[0]?.status, 'FILED');
  assert.equal(recorded.snapshots.length, 0, 'filing must not fabricate a source snapshot before validators fetch it');
});

/* ---------------------------------------------------------------------- the commitment */

test('the digest handed to the court is the one the browser computed', async () => {
  const digest = await sha256Hex('a scan of the letter, hashed on the member machine');
  const { deps, recorded } = harness();
  const res = await fileCase(post(body({ evidenceSha256: digest })), deps);

  assert.equal(res.status, 200);
  assert.equal(String(recorded.writes[0]?.args[9]), digest);
  assert.equal(recorded.cases[0]?.evidenceSha256, digest);

  const payload = (await res.json()) as { evidenceSha256: string; evidenceOrigin: string };
  assert.equal(payload.evidenceSha256, digest);
  assert.equal(payload.evidenceOrigin, 'browser_digest');
});

test('a filing with no digest commits to a hash of the letter and says so', async () => {
  const { deps, recorded } = harness();
  const res = await fileCase(post(body()), deps);

  assert.equal(res.status, 200);
  assert.equal(String(recorded.writes[0]?.args[9]), await sha256Hex(LETTER));

  const payload = (await res.json()) as { evidenceOrigin: string };
  assert.equal(payload.evidenceOrigin, 'letter_text');
});

test('a filing whose digest contradicts its document is refused, nothing signed', async () => {
  const { deps, recorded } = harness();
  const res = await fileCase(
    post(
      body({
        evidenceSha256: await sha256Hex('one document'),
        evidenceBytes: Buffer.from('a different document', 'utf8').toString('base64'),
      }),
    ),
    deps,
  );

  assert.equal(res.status, 422);
  assert.equal(recorded.writes.length, 0);
});

test('the letter never reaches the chain, only its hash', async () => {
  const { deps, recorded } = harness();
  await fileCase(post(body()), deps);

  const args = JSON.stringify(recorded.writes[0]?.args);
  assert.ok(!args.includes('Dear Member'));
  assert.ok(!args.includes('We have completed our review'));
  // The codes and the rationale do go, which is the whole point of the record.
  assert.ok(args.includes('43644'));
  assert.ok(args.includes('not medically necessary'));
});

/* ------------------------------------------------------------- validation and refusals */

test('a body that is missing a required field is refused with a 400', async () => {
  const { deps, recorded } = harness();
  const incomplete = body();
  delete incomplete.planId;

  const res = await fileCase(post(incomplete), deps);
  assert.equal(res.status, 400);
  assert.equal(recorded.writes.length, 0);
});

test('an identifier in the rationale is redacted and never reaches the chain', async () => {
  const { deps, recorded } = harness();
  const res = await fileCase(
    post(
      body({
        denialRationale:
          'Benefit denied for member ID 48821207 because the requested procedure is not ' +
          'considered medically necessary under the applicable clinical policy.',
      }),
    ),
    deps,
  );

  assert.equal(res.status, 200);
  const args = JSON.stringify(recorded.writes[0]?.args);
  assert.ok(!args.includes('48821207'), 'the member id reached the chain');
  assert.ok(args.includes('[REDACTED:MEMBER_ID]'));

  const payload = (await res.json()) as { redactions: Array<{ kind: string; count: number }> };
  assert.ok(payload.redactions.some((entry) => entry.kind === 'MEMBER_ID'));
});

test('a source URL carrying an identifier is refused with a 422, and not echoed back', async () => {
  // Source URLs are not scrubbed, because a half rewritten URL is worse than a refusal:
  // a validator has to be able to re-fetch exactly what it was given. So this is the
  // path where de-identification refuses outright rather than redacting.
  const { deps, recorded } = harness();
  const res = await fileCase(
    post({
      ...body(),
      sourceUrls: [
        'https://www.aetna.com/cpb/medical/data/100_199/0157.html',
        'https://portal.example.com/claims?member_id=48821207',
      ],
    }),
    deps,
  );

  assert.equal(res.status, 422);
  const payload = (await res.json()) as { error: string };
  assert.match(payload.error, /We stopped before sending anything/);
  assert.match(payload.error, /source_urls\[1\]/);
  // The matched value is PHI and a refusal ends up in a log, so it is never in there.
  assert.ok(!payload.error.includes('48821207'));
  assert.equal(recorded.writes.length, 0);
  assert.equal(recorded.cases.length, 0);
});

test('a refused filing exposes a safe message and transaction hash', async () => {
  const { deps, recorded } = harness({}, { ok: false, error: '[EXPECTED] that rule has lapsed' });
  const res = await fileCase(post(body()), deps);

  assert.equal(res.status, 422);
  const payload = (await res.json()) as { error: string; txHash: string };
  assert.match(payload.error, /The court refused/);
  assert.ok(!payload.error.includes('that rule has lapsed'));
  assert.equal(payload.txHash, TX_HASH);
  // A refused filing is not written to the index.
  assert.equal(recorded.cases.length, 0);
});

test('consensus outlasting the request becomes a 202 carrying the transaction', async () => {
  const { deps, recorded } = harness({}, { timeout: true });
  const res = await fileCase(post(body()), deps);

  assert.equal(res.status, 202);
  const payload = (await res.json()) as { pending: boolean; docket: null; txHash: string };
  assert.equal(payload.pending, true);
  assert.equal(payload.docket, null);
  assert.equal(payload.txHash, TIMEOUT_TX_HASH);
  assert.equal(recorded.cases.length, 0);
});

test('a receipt with no docket in it is reported rather than invented', async () => {
  const { deps, recorded } = harness({}, { receipt: { consensus_data: { leader_receipt: [] } } });
  const res = await fileCase(post(body()), deps);

  assert.equal(res.status, 200);
  const payload = (await res.json()) as { docket: string | null };
  assert.equal(payload.docket, null);
  assert.equal(recorded.cases.length, 0);
});


test('a contract error carrying patient data is never echoed', async () => {
  const secret = 'private-patient@example.com';
  const { deps } = harness({}, { ok: false, error: `[EXPECTED] invalid input ${secret}` });
  const res = await fileCase(post(body()), deps);
  assert.equal(res.status, 422);
  assert.ok(!(await res.text()).includes(secret));
});
