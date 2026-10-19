/** Verify a small underwriter withdrawal without requiring a new model judgment. */
import fs from 'node:fs';
import path from 'node:path';
import { chainClient, addresses, read, ROOT } from './chain.mjs';
import { assertReceipt } from './receipts.mjs';
const c = chainClient(); const { pool } = addresses(); const amount = 10n ** 15n;
const statePath = path.join(ROOT, 'deploy/.payout-check.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : { pool, amount: String(amount) };
function save() { fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(`${statePath}.tmp`, statePath); }
try {
  if (state.pool !== pool) throw new Error('Payout test state belongs to another pool.');
  if (!state.hash) {
    if (state.submitting) throw new Error('Withdrawal broadcast is unknown; recover its hash before retrying.');
    state.before = String(await c.getBalance({ address: c.account.address }));
    state.submitting = true; save();
    state.hash = await c.writeContract({ address: pool, functionName: 'withdraw', args: [String(amount)], value: 0n }); save();
    console.log(`withdrawal: ${state.hash}`);
  }
  const receipt = await c.waitForTransactionReceipt({ hash: state.hash, status: 'FINALIZED', interval: 8000, retries: 120 });
  assertReceipt(receipt, 'withdrawal');
  const history = await read(c, pool, 'payout_history', [0, 25, c.account.address]);
  const payout = history.items.find((p) => p.kind === 'WITHDRAW' && p.amount_atto === String(amount));
  if (!payout) throw new Error('No matching withdrawal payout was recorded.');
  const after = await c.getBalance({ address: c.account.address });
  const observed = after >= BigInt(state.before) + amount;
  const report = { checkedAt: new Date().toISOString(), network: 'studionet', pool,
    txHash: state.hash, recipient: c.account.address, amountAtto: String(amount),
    parent: 'FINALIZED', balanceBefore: state.before, balanceAfter: String(after), recipientCreditObserved: observed,
    payout, note: 'Balance observation for this small test is separate from parent execution. No automatic retry or general network-delivery guarantee is inferred.' };
  fs.writeFileSync(path.join(ROOT, 'deployments/milestone-payout-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Withdrawal finalized. Recipient balance credit observed: ${observed}. Payout record remains ${payout.status}.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
