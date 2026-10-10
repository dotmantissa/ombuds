/**
 * Round 4. New court and new pool; the registry is kept and its rules re-seeded so the
 * corrected clause_sections land without discarding consensus digests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createAccount } from 'genlayer-js';
import { chainClient, addresses, send, read, ROOT, RPC } from '/home/dotmantissa/GenLayer_dApps/ombuds/scripts/chain.mjs';

const ATTO = 10n ** 18n;
const MIN_CONFIDENCE = 70;
const REVIEW_BOND_ATTO = (ATTO * 25n) / 100n;
const ADVANCE_RATE_BPS = 3500;
const FEE_BPS = 1200;
const MAX_UTILISATION_BPS = 7000;
const BAND_CAPS_ATTO = [ATTO / 4n, ATTO / 2n, ATTO, ATTO * 2n, ATTO * 3n, ATTO * 4n].map(String).join(',');

const STATE = path.join(ROOT, 'deploy', '.redeploy-state.json');
const state = fs.existsSync(STATE) && !process.argv.includes('--restart')
  ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { steps: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, what, fn) {
  if (state.steps[name]) { console.log(`\n[${name}] done already: ${JSON.stringify(state.steps[name])}`); return state.steps[name]; }
  console.log(`\n[${name}] ${what}`);
  state.steps[name] = (await fn()) ?? { done: true };
  save();
  return state.steps[name];
}

function hiccup(err) {
  const t = String(err?.message || err);
  return ['is not valid JSON','Service temporarily unavailable','Requested resource not available','RemoteDisconnected','Remote end closed','ECONNRESET','socket hang up','fetch failed','502'].some((s) => t.includes(s));
}

async function deploy(client, name, file, args) {
  const code = fs.readFileSync(path.join(ROOT, 'contracts', file), 'utf8');
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const txHash = await client.deployContract({ code, args });
      console.log(`    tx ${txHash}`);
      const receipt = await client.waitForTransactionReceipt({ hash: txHash, status: 'ACCEPTED', interval: 3000, retries: 240 });
      const exec = receipt?.data?.execution_result ?? receipt?.execution_result;
      if (exec && String(exec).toUpperCase().includes('ERROR')) {
        throw new Error(`${name} accepted but its constructor failed: ${String(receipt?.data?.stderr || '').slice(0, 300)}`);
      }
      let address = receipt?.contract_address || receipt?.contractAddress || receipt?.data?.contract_address;
      if (!address) {
        const tx = await client.getTransaction({ hash: txHash });
        address = tx?.data?.contract_address || tx?.contract_address || tx?.to || null;
      }
      if (!address) throw new Error(`${name} produced no contract address`);
      console.log(`    ${name} live at ${address}`);
      return { address, txHash };
    } catch (err) {
      if (!hiccup(err) || attempt === 4) throw err;
      console.log(`    hiccup, retry in ${5 * attempt}s`);
      await sleep(5000 * attempt);
    }
  }
}

function patchEnv(values) {
  const envPath = path.join(ROOT, '.env');
  let text = fs.readFileSync(envPath, 'utf8');
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(envPath, text, { mode: 0o600 });
}

const client = chainClient();
const account = createAccount(process.env.DEPLOYER_KEY);
const existing = addresses();
console.log(`endpoint  ${RPC}\ndeployer  ${account.address}\nregistry  ${existing.registry} (kept)`);

const court = await step('court', 'deploying OmbudsCourt', () =>
  deploy(client, 'OmbudsCourt', 'ombuds_court.py', [existing.registry, MIN_CONFIDENCE, REVIEW_BOND_ATTO.toString()]));

const pool = await step('pool', 'deploying AdvancePool', () =>
  deploy(client, 'AdvancePool', 'advance_pool.py', [court.address, ADVANCE_RATE_BPS, FEE_BPS, MAX_UTILISATION_BPS, BAND_CAPS_ATTO]));

await step('wire', 'set_pool on the new court', async () => {
  await send(client, court.address, 'set_pool', [pool.address], 'set_pool');
  return { court: court.address, pool: pool.address };
});

await step('env', 'writing .env', async () => {
  patchEnv({ OMBUDS_COURT_ADDRESS: court.address, ADVANCE_POOL_ADDRESS: pool.address });
  return { written: true };
});

console.log('\nreading back');
const cfg = await read(client, court.address, 'get_config', []);
console.log(`  registry ok ${String(cfg.registry).toLowerCase() === String(existing.registry).toLowerCase()}`);
console.log(`  pool ok     ${String(cfg.pool).toLowerCase() === String(pool.address).toLowerCase()}`);
console.log(`\ncourt ${court.address}\npool  ${pool.address}`);
