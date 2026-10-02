/**
 * deploy/fund_pool.mjs
 *
 * Deposits real capital into AdvancePool so the Total Value Governed figure on the pool
 * page is an actual escrow balance and not a decoration.
 *
 * Usage:  node deploy/fund_pool.mjs 12
 */

import { chainClient, addresses, send } from '../scripts/chain.mjs';

const ATTO = 10n ** 18n;
const gen = process.argv[2] ? BigInt(process.argv[2]) : 12n;
const amount = gen * ATTO;

const client = chainClient();
const { pool } = addresses();
if (!pool) {
  console.error('ADVANCE_POOL_ADDRESS is missing from .env. Deploy first.');
  process.exit(1);
}

const before = await client.readContract({ address: pool, functionName: 'pool_stats', args: [] });
console.log(`pool ${pool}`);
console.log(`TVG before  ${before.total_value_governed_atto} atto`);
console.log(`depositing  ${gen} GEN\n`);

const txHash = await client.writeContract({
  address: pool,
  functionName: 'deposit',
  args: [],
  value: amount,
});
await client.waitForTransactionReceipt({
  hash: txHash,
  status: 'ACCEPTED',
  interval: 3000,
  retries: 200,
});
console.log(`  ok  deposit  ${txHash}`);

const after = await client.readContract({ address: pool, functionName: 'pool_stats', args: [] });
console.log(`\nTVG after         ${after.total_value_governed_atto} atto`);
console.log(`free capital      ${after.free_capital_atto} atto`);
console.log(`underwriters      ${after.underwriter_count}`);
console.log(`utilisation       ${after.utilisation_bps} bps`);
