/** Reproducible full contract lifecycle, then optionally serve the browser test app. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync('python3', ['scripts/prepare_test_sdk.py'], { cwd: root, stdio: 'inherit' });
const ATTO = 10n ** 18n;
const owner = `0x${'11'.repeat(20)}`;
const claimant = `0x${'22'.repeat(20)}`;
const underwriter = `0x${'33'.repeat(20)}`;
const rpcUrl = 'http://127.0.0.1:4010/api';
let next;
const log = fs.openSync(path.join(root, 'localnet-test.log'), 'w');
const sim = spawn('python3', ['tests/localnet/server.py'], { cwd: root, stdio: ['ignore', log, log] });
function stop() { next?.kill('SIGTERM'); sim.kill('SIGTERM'); }
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
async function rpc(method, params = {}) {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
async function call(to, method, args = [], { sender = owner, value = 0n, overturn, error } = {}) {
  const result = await rpc('ombuds_testCall', { to, method, args, sender, value: String(value), overturn });
  if (error) { assert.match(result.error ?? '', error); return result; }
  assert.equal(result.error, null, `${method}: ${result.error}`);
  assert.ok(result.votes.every((v) => v === 'agree'), `${method}: ${JSON.stringify(result.votes)}`);
  return result.result;
}
async function read(to, method, args = []) { return (await rpc('sim_read', { to, method, args })).result; }
async function deploy(file, args = []) { return (await rpc('sim_deploy', { code_path: path.join(root, 'contracts', file), args, sender: owner })).contract_address; }
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await rpc('ping'); ready = true; break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  assert.ok(ready, 'Local simulator failed to start; inspect localnet-test.log');
  await rpc('sim_setTime', { datetime: '2026-10-19T10:00:00Z' });
  const registry = await deploy('plan_registry.py');
  await call(registry, 'register_rule', ['AETNA-COMMERCIAL-BARIATRIC', 'Aetna', 'Commercial', 'bariatric_surgery', '0157', 'Obesity Surgery',
    'https://www.aetna.com/cpb/medical/data/100_199/0157.html', 'html', 'US', '2026-01-01', '2027-01-01',
    'https://api.coverage.cms.gov/v1/data/ncd?ncdid=57&ncdver=5', '100.1', '', 'Scope of Policy|Medical Necessity|Experimental, Investigational, or Unproven|Related Policies|Background']);
  const court = await deploy('ombuds_court.py', [registry, 70, String(ATTO / 4n)]);
  const pool = await deploy('advance_pool.py', [court, 3500, 1200, 7000, [ATTO / 4n, ATTO / 2n, ATTO, 2n * ATTO, 3n * ATTO, 4n * ATTO].map(String).join(',')]);
  await call(court, 'set_pool', [pool]);
  await call(pool, 'deposit', [], { sender: underwriter, value: 10n * ATTO });
  const docket = await call(court, 'file_case', ['AETNA-COMMERCIAL-BARIATRIC', 'bariatric_surgery', 'TX', '43644', 'E66.01', '50',
    'Benefit denied because the procedure is considered not medically necessary under the applicable clinical policy.', '2026-04', String(12000n * ATTO), 'a'.repeat(64), claimant]);
  await call(court, 'adjudicate', [docket]);
  const original = await read(court, 'get_verdict', [docket]);
  assert.equal(original.overturn_recommended, true);
  const advanced = await call(pool, 'advance', [docket]);
  const amount = BigInt(advanced.amount_atto);
  assert.equal((await read(court, 'get_case', [docket])).status, 'ADVANCED');
  await call(pool, 'advance', [docket], { error: /already been advanced/ });
  await call(court, 'request_review', [docket], { sender: claimant, value: ATTO / 4n });
  await call(court, 'adjudicate', [docket], { overturn: false });
  await call(court, 'resolve_review', [docket]);
  assert.equal((await read(court, 'get_case', [docket])).status, 'ADVANCED');
  const verdicts = await read(court, 'verdict_history', [docket]);
  assert.deepEqual(verdicts.items[0], original);
  assert.equal(verdicts.items[1].overturn_recommended, false);
  assert.equal(await read(court, 'bond_of', [claimant]), String(ATTO / 4n));
  await call(pool, 'record_recovery', [docket, 'remittance-first'], { value: amount / 2n });
  assert.equal((await read(pool, 'pool_stats')).total_value_governed_atto, String(10n * ATTO));
  await call(pool, 'record_recovery', [docket, 'remittance-first'], { value: 1n, error: /already processed/ });
  const fee = amount * 1200n / 10000n;
  await call(pool, 'record_recovery', [docket, 'remittance-final'], { value: amount - amount / 2n + fee + ATTO / 10n });
  assert.equal((await read(court, 'get_case', [docket])).status, 'SETTLED');
  assert.equal((await read(pool, 'pool_stats')).outstanding_atto, '0');
  assert.equal(await read(pool, 'claimable_of', [claimant]), String(ATTO / 10n));
  await call(pool, 'claim_for', [claimant]);
  assert.equal(await read(pool, 'claimable_of', [claimant]), '0');
  await call(pool, 'withdraw', [String(ATTO)], { sender: underwriter });
  const payouts = await read(pool, 'payout_history');
  assert.ok(payouts.items.every((p) => p.status === 'PENDING'));
  await call(pool, 'retry_payout', [advanced.payout_id], { error: /funded refund/ });
  await call(pool, 'refund_payout', [advanced.payout_id], { value: amount });
  await call(pool, 'retry_payout', [advanced.payout_id]);
  assert.equal((await read(pool, 'get_payout', [advanced.payout_id])).attempt, 2);
  await call(registry, 'extend_rule', ['AETNA-COMMERCIAL-BARIATRIC', '2028-01-01']);
  assert.equal((await read(registry, 'policy_history', ['AETNA-COMMERCIAL-BARIATRIC'])).total, 2);
  assert.equal((await read(court, 'verdict_history', [docket])).items[0].provenance.policy.effective_to, '2027-01-01');
  console.log('Local lifecycle passed: filing, independent validator review, advance, changed appeal, bond, partial recovery, duplicate refusal, settlement, surplus, withdrawal and funded retry.');
  if (process.argv.includes('--serve')) {
    const env = { ...process.env, PLAN_REGISTRY_ADDRESS: registry, OMBUDS_COURT_ADDRESS: court, ADVANCE_POOL_ADDRESS: pool,
      GENLAYER_RPC_URL: rpcUrl, NEXT_PUBLIC_PRIVY_APP_ID: '', OMBUDS_E2E: '1' };
    next = spawn(path.join(root, 'web/node_modules/.bin/next'), ['dev', '--hostname', '127.0.0.1', '--port', '3100'], { cwd: path.join(root, 'web'), env, stdio: 'inherit' });
    await new Promise((resolve) => next.once('exit', resolve));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { stop(); }
