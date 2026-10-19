/** Small, recoverable live smoke test. Uses synthetic case text and 0.01 GEN. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chainClient, addresses, read, ROOT } from './chain.mjs';
import { assertReceipt, receiptOutcome } from './receipts.mjs';
const c = chainClient(); const a = addresses(); const ATTO = 10n ** 18n;
const statePath = path.join(ROOT, 'deploy', '.milestone-smoke.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : { addresses: a, steps: {} };
if (JSON.stringify(state.addresses) !== JSON.stringify(a)) throw new Error('Smoke state belongs to different contracts.');
function save() { fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(`${statePath}.tmp`, statePath); }
async function write(name, address, method, args, value = 0n) {
  let s = state.steps[name];
  if (!s) { state.steps[name] = { status: 'SUBMITTING' }; save();
    const hash = await c.writeContract({ address, functionName: method, args, value, consensusMaxRotations: method === 'adjudicate' ? 5 : 3 });
    s = state.steps[name] = { hash, status: 'PENDING' }; save(); console.log(`${name}: ${hash}`); }
  if (!s.hash) throw new Error(`${name}: unknown broadcast; no retry is safe without a hash.`);
  if (s.status !== 'EXECUTED') {
    const receipt = await c.waitForTransactionReceipt({ hash: s.hash, status: 'ACCEPTED', interval: 8000, retries: 120 });
    assertReceipt(receipt, name); s.status = 'EXECUTED'; save();
  }
  return s.hash;
}
try {
  if (process.argv.includes('--retry-panel')) {
    if ((state.panelFailures ?? []).length >= 1) throw new Error('The bounded fresh-panel retry was already used.');
    const prior = state.steps.adjudicate;
    if (!prior?.hash || !state.docket) throw new Error('There is no failed panel to retry.');
    const receipt = await c.getTransaction({ hash: prior.hash });
    const outcome = receiptOutcome(receipt);
    const kase = await read(c, a.court, 'get_case', [state.docket]);
    if (outcome.status !== 'FINALIZED' || outcome.consensus !== 'MAJORITY_DISAGREE' || kase.has_verdict || kase.status !== 'FILED') {
      throw new Error('The previous panel is not a confirmed, finalized rejection of an unadjudicated case.');
    }
    state.panelFailures = [...(state.panelFailures ?? []), { ...prior, outcome, checkedAt: new Date().toISOString() }];
    delete state.steps.adjudicate;
    save();
  }
  const plan = 'AETNA-COMMERCIAL-BARIATRIC_SURGERY';
  await write('refresh_policy', a.registry, 'refresh_rule', [plan]);
  await write('deposit', a.pool, 'deposit', [], ATTO / 100n);
  const rationale = 'Benefit denied because bariatric surgery is considered not medically necessary. The requested sleeve gastrectomy meets the published clinical policy criteria for persistent severe obesity following prior nonsurgical treatment.';
  const evidence = createHash('sha256').update(`Ombuds milestone synthetic lifecycle: ${rationale}`).digest('hex');
  await write('file', a.court, 'file_case', [plan, 'bariatric_surgery', 'TX', '43775', 'E66.01|Z68.41', '50', rationale, '2026-04', String(12000n * ATTO), evidence, c.account.address]);
  if (!state.docket) {
    const ids = await read(c, a.court, 'cases_for_filer', [c.account.address]);
    const matches = await Promise.all(ids.map(async (id) => ({ id, record: await read(c, a.court, 'get_case', [id]) })));
    const match = matches.find((m) => m.record.evidence_sha256 === evidence);
    if (!match) throw new Error('The filed case could not be identified by its exact commitment.');
    state.docket = match.id; save();
  }
  const docket = state.docket;
  await write('adjudicate', a.court, 'adjudicate', [docket]);
  const history = await read(c, a.court, 'verdict_history', [docket, 0, 25]);
  if (history.items.length !== 1 || !history.items[0].provenance.policy.policy_version) throw new Error('Verdict provenance was not recorded.');
  const quote = await read(c, a.pool, 'quote_advance', [docket]);
  if (!quote.eligible && !state.steps.advance) throw new Error(`No live advance was attempted: ${quote.reason}`);
  if (!state.recipientBalanceBefore) { state.recipientBalanceBefore = String(await c.getBalance({ address: c.account.address })); save(); }
  await write('advance', a.pool, 'advance', [docket]);
  const advance = await read(c, a.pool, 'get_advance', [docket]);
  const amount = BigInt(advance.amount_atto); const fee = amount * BigInt(advance.fee_rate_bps) / 10000n;
  await write('partial_recovery', a.pool, 'record_recovery', [docket, `milestone-${docket}-part`], amount / 2n);
  const partialStats = await read(c, a.pool, 'pool_stats');
  if (partialStats.outstanding_atto !== String(amount - amount / 2n)) throw new Error('Partial repayment accounting failed.');
  await write('final_recovery', a.pool, 'record_recovery', [docket, `milestone-${docket}-final`], amount - amount / 2n + fee);
  // Wait for finalization and its transfer activation separately from parent execution.
  const finalized = await c.waitForTransactionReceipt({ hash: state.steps.advance.hash, status: 'FINALIZED', interval: 8000, retries: 120 });
  assertReceipt(finalized, 'finalized advance');
  const balanceAfter = await c.getBalance({ address: c.account.address });
  // Recoveries are also paid by this account. Adjust those known debits when testing receipt.
  const expectedWithoutPayout = BigInt(state.recipientBalanceBefore) - amount - fee;
  const delivered = balanceAfter >= expectedWithoutPayout + amount;
  const payout = await read(c, a.pool, 'get_payout', [advance.payout_id]);
  const report = { network: 'studionet', checkedAt: new Date().toISOString(), addresses: a, docket,
    transactions: state.steps, policy: await read(c, a.registry, 'rule_for', [plan]),
    case: await read(c, a.court, 'get_case', [docket]), verdictHistory: history,
    poolStats: await read(c, a.pool, 'pool_stats'), position: await read(c, a.pool, 'position_of', [c.account.address]),
    payout, nativeDelivery: { confirmedByBalance: delivered, recipientBalanceBefore: state.recipientBalanceBefore,
      recipientBalanceAfter: String(balanceAfter), knownRecoveryDebitsAtto: String(amount + fee), amountAtto: String(amount),
      note: 'Parent execution and recipient credit are distinct. No payout is retried based on timeout or balance inference.' } };
  fs.writeFileSync(path.join(ROOT, 'deployments/milestone-live-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Live verification complete for ${docket}. Native recipient credit observed: ${delivered}.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
