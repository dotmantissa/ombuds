/**
 * scripts/e2e_case.mjs
 *
 * Runs one real case all the way through, against real sources and real validator
 * consensus. Nothing in here is mocked.
 *
 *   1. file a de-identified case
 *   2. adjudicate it, which makes every validator re-fetch the Aetna bulletin and the CMS
 *      determination, re-audit the codes and agree on four fields
 *   3. read the verdict back
 *   4. ask the pool what it would advance, and take it
 */

import { chainClient, addresses, send, read } from './chain.mjs';
import crypto from 'node:crypto';

const client = chainClient();
const { court, pool } = addresses();

const ATTO = 10n ** 18n;

// A de-identified record. This is exactly the shape the web client produces: codes, a
// reason code, one scrubbed sentence, a plan id, a state, a month, an amount and a hash.
// There is no name, no member id and no full date anywhere in it.
const letter =
  'We have completed our review of the request for gastric bypass surgery. ' +
  'Benefit denied because the requested procedure is considered not medically necessary ' +
  'for this member under the applicable clinical policy bulletin.';
const evidence = crypto.createHash('sha256').update(letter, 'utf8').digest('hex');

const rationale =
  'Benefit denied because the requested procedure is considered not medically necessary ' +
  'for this member under the applicable clinical policy bulletin.';

console.log('court', court);
console.log('pool ', pool, '\n');

// The tripwire first, the way the UI does it.
const flags = await read(client, court, 'phi_scan', [rationale]);
console.log('phi_scan on the rationale:', JSON.stringify(flags));
if (flags.length > 0) {
  console.error('That rationale would be refused. Stopping.');
  process.exit(1);
}

console.log('\n1. filing');
await send(
  client,
  court,
  'file_case',
  [
    'AETNA-COMMERCIAL-BARIATRIC_SURGERY',
    'bariatric_surgery',
    'TX',
    '43644|43775',
    'E66.01|Z68.41',
    '50',
    rationale,
    '2026-04',
    (12_000n * ATTO).toString(),
    evidence,
  ],
  'file_case',
);

const stats = await read(client, court, 'court_stats', []);
const page = await read(client, court, 'docket_page', [0, 1]);
const docket = page[0]?.docket;
console.log(`   docket ${docket}, ${stats.case_count} case(s) on the docket`);

console.log('\n2. adjudicating. Every validator now re-fetches both sources and reruns the job.');
console.log('   This takes a while on purpose.');
const started = Date.now();
// Rotations matter here and nowhere else in this script. Every validator makes two model
// calls on an adjudication, so an occasional split panel is normal, and rotating the panel
// is the protocol's designed response to one. Without this a single disagreement ends the
// transaction with nothing written.
await send(client, court, 'adjudicate', [docket], 'adjudicate', 0n, {
  consensusMaxRotations: 5,
  waitRetries: 400,
});
console.log(`   consensus reached in ${Math.round((Date.now() - started) / 1000)}s`);

console.log('\n3. the verdict, read back off the contract');
const verdict = await read(client, court, 'get_verdict', [docket]);
console.log('   overturn_recommended ', verdict.overturn_recommended);
console.log('   ground               ', verdict.ground);
console.log('   clause_id            ', verdict.clause_id);
console.log('   clause_section       ', verdict.clause_section);
console.log('   recoverable_band     ', verdict.recoverable_band, `(${verdict.recoverable_band_label})`);
console.log('   confidence           ', verdict.confidence, '| clears the money line:', verdict.crosses_confidence_band);
console.log('   digest               ', verdict.digest);
console.log('   bulletin_digest      ', verdict.bulletin_digest);
console.log('   cms_digest           ', verdict.cms_digest);
console.log('   citations            ', verdict.citations.length);
for (const c of verdict.citations) console.log(`     - ${c.source} at "${c.locator}"`);
console.log('\n   quoted clause, verbatim from the bulletin:');
console.log('   "' + String(verdict.clause_quote).slice(0, 220) + '"');
console.log('\n   reasoning:');
console.log('   ' + String(verdict.reasoning).slice(0, 400));

console.log('\n4. the pool');
const gate = await read(client, court, 'is_advanceable', [docket]);
console.log('   court says advanceable:', gate.ok, gate.reason ? `(${gate.reason})` : '');

if (gate.ok) {
  const quote = await read(client, pool, 'quote_advance', [docket]);
  console.log('   quote:', quote.amount_atto, 'atto, limited by', quote.limited_by);
  await send(client, pool, 'advance', [docket], 'advance');
  const record = await read(client, pool, 'get_advance', [docket]);
  console.log('   advanced', record.amount_atto, 'atto to', record.member, '| status', record.status);
  const after = await read(client, pool, 'pool_stats', []);
  console.log('   pool TVG', after.total_value_governed_atto, '| outstanding', after.outstanding_atto);
  const caseAfter = await read(client, court, 'get_case', [docket]);
  console.log('   case status now', caseAfter.status);
}

console.log(`\ndone. http://127.0.0.1:3000/case/${docket}`);
