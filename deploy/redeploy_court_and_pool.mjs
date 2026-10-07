/**
 * deploy/redeploy_court_and_pool.mjs
 *
 * Round 2 redeploy. Replaces OmbudsCourt and AdvancePool and KEEPS the existing
 * PlanRegistry.
 *
 * Why only two of three. OmbudsCourt has to move because its storage layout changed:
 * Case gained pre_review_ruling, Verdict gained ruling_digest, and REVIEWED is a new
 * status. AdvancePool's code did not change, but its ledger holds an outstanding advance
 * against a docket the new court will never have heard of, so settle() on it could never
 * succeed. PlanRegistry did not change at all, and its five rules carry consensus digests
 * that cost real validator rounds to seed, so re-seeding would buy nothing.
 *
 * Runs in six steps and records each one in deploy/.redeploy-state.json, because the
 * studio endpoint drops connections often enough that a half finished run is a real
 * possibility. Re-running picks up where it stopped instead of deploying a second court.
 *
 *   node deploy/redeploy_court_and_pool.mjs            run, resuming if there is state
 *   node deploy/redeploy_court_and_pool.mjs --restart  throw the state away and start over
 *   node deploy/redeploy_court_and_pool.mjs --dry-run  print the plan and read the chain
 */

import fs from 'node:fs';
import path from 'node:path';
import { createAccount } from 'genlayer-js';
import { chainClient, addresses, send, read, ROOT, RPC } from '../scripts/chain.mjs';

const ATTO = 10n ** 18n;

// Same terms the first deploy used. Kept here rather than imported so this script is a
// complete record of what the live contracts were constructed with.
const MIN_CONFIDENCE = 70;
const REVIEW_BOND_ATTO = (ATTO * 25n) / 100n;
const ADVANCE_RATE_BPS = 3500;
const FEE_BPS = 1200;
const MAX_UTILISATION_BPS = 7000;
const BAND_CAPS_ATTO = [ATTO / 4n, ATTO / 2n, ATTO, ATTO * 2n, ATTO * 3n, ATTO * 4n]
  .map(String)
  .join(',');
const FUND_GEN = 12n;

const STATE_PATH = path.join(ROOT, 'deploy', '.redeploy-state.json');
const DRY = process.argv.includes('--dry-run');
const RESTART = process.argv.includes('--restart');

function loadState() {
  if (RESTART || !fs.existsSync(STATE_PATH)) return { steps: {} };
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  if (DRY) return;
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

const state = loadState();

/** Runs a step once, ever. The state file is what makes that true across crashes. */
async function step(name, what, fn) {
  if (state.steps[name]) {
    console.log(`\n[${name}] already done, skipping`);
    console.log(`    ${JSON.stringify(state.steps[name])}`);
    return state.steps[name];
  }
  console.log(`\n[${name}] ${what}`);
  if (DRY) {
    console.log('    dry run, not sent');
    return null;
  }
  const result = (await fn()) ?? { done: true };
  state.steps[name] = result;
  saveState(state);
  return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransportHiccup(err) {
  const text = String(err?.message || err);
  return (
    text.includes('is not valid JSON') ||
    text.includes('Service temporarily unavailable') ||
    text.includes('Requested resource not available') ||
    text.includes('RemoteDisconnected') ||
    text.includes('Remote end closed') ||
    text.includes('ECONNRESET') ||
    text.includes('socket hang up') ||
    text.includes('fetch failed') ||
    text.includes('502')
  );
}

/**
 * Deploy with the same retry tolerance the rest of the tooling has. A deploy that is
 * accepted but whose code raised still creates no contract, so the receipt is read rather
 * than trusted.
 */
async function deploy(client, name, file, args) {
  const code = fs.readFileSync(path.join(ROOT, 'contracts', file), 'utf8');

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const txHash = await client.deployContract({ code, args });
      console.log(`    tx ${txHash}`);

      const receipt = await client.waitForTransactionReceipt({
        hash: txHash,
        status: 'ACCEPTED',
        interval: 3000,
        retries: 240,
      });

      const exec = receipt?.data?.execution_result ?? receipt?.execution_result;
      if (exec && String(exec).toUpperCase().includes('ERROR')) {
        const stderr = receipt?.data?.stderr || receipt?.stderr || '';
        throw new Error(
          `${name} was accepted but its constructor failed${stderr ? `: ${String(stderr).slice(0, 400)}` : ''}`,
        );
      }

      let address =
        receipt?.contract_address || receipt?.contractAddress || receipt?.data?.contract_address;
      if (!address) {
        const tx = await client.getTransaction({ hash: txHash });
        address = tx?.data?.contract_address || tx?.contract_address || tx?.to || null;
      }
      if (!address) throw new Error(`${name} produced no contract address`);

      console.log(`    ${name} is live at ${address}`);
      return { address, txHash };
    } catch (err) {
      if (!isTransportHiccup(err) || attempt === 4) throw err;
      const wait = 5000 * attempt;
      console.log(`    transport hiccup deploying ${name}, retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

function patchEnv(values) {
  const envPath = path.join(ROOT, '.env');
  let text = fs.readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(envPath, text, { mode: 0o600 });
}

async function main() {
  const client = chainClient();
  const account = createAccount(process.env.DEPLOYER_KEY);
  const existing = addresses();

  console.log(`Endpoint   ${RPC}`);
  console.log(`Deployer   ${account.address}`);
  console.log(`Registry   ${existing.registry}  (KEEPING, not redeployed)`);
  console.log(`Old court  ${existing.court}`);
  console.log(`Old pool   ${existing.pool}`);
  if (DRY) console.log('\n*** DRY RUN ***');

  if (!existing.registry) throw new Error('PLAN_REGISTRY_ADDRESS is missing from .env');

  // The registry is being kept, so prove it is actually there and populated before
  // anything is torn down.
  const rs = await read(client, existing.registry, 'registry_stats', []);
  console.log(`\nRegistry holds ${rs.rule_count} rules, ${rs.active_count} active`);
  if (Number(rs.active_count) < 1) {
    throw new Error('the registry has no active rules, so keeping it is not safe');
  }

  const before = await read(client, existing.pool, 'pool_stats', []);
  console.log(
    `Old pool: free ${before.free_capital_atto} atto, outstanding ${before.outstanding_atto} atto`,
  );

  // ---- 9a: get the free capital out of the old pool ----------------------
  // The 2 GEN advance already left the contract when it paid the member, so free capital
  // is the whole of what remains and the sole underwriter may take it.
  await step('withdraw_old_pool', 'withdrawing free capital from the old pool', async () => {
    const free = BigInt(before.free_capital_atto);
    if (free <= 0n) {
      console.log('    nothing free to withdraw');
      return { withdrawn_atto: '0' };
    }
    await send(
      client,
      existing.pool,
      'withdraw',
      [String(free)],
      `withdrawing ${free / ATTO} GEN from the old pool`,
    );
    return { withdrawn_atto: String(free), from: existing.pool };
  });

  // ---- 9b: the new court, against the registry we are keeping ------------
  const court = await step('deploy_court', 'deploying OmbudsCourt', () =>
    deploy(client, 'OmbudsCourt', 'ombuds_court.py', [
      existing.registry,
      MIN_CONFIDENCE,
      REVIEW_BOND_ATTO.toString(),
    ]),
  );

  // ---- 9c: the new pool, then wire the court to it -----------------------
  const pool = await step('deploy_pool', 'deploying AdvancePool', () =>
    deploy(client, 'AdvancePool', 'advance_pool.py', [
      court.address,
      ADVANCE_RATE_BPS,
      FEE_BPS,
      MAX_UTILISATION_BPS,
      BAND_CAPS_ATTO,
    ]),
  );

  await step('wire', 'telling the new court about the new pool', async () => {
    await send(client, court.address, 'set_pool', [pool.address], 'set_pool');
    return { court: court.address, pool: pool.address };
  });

  // ---- 9d: fund the new pool, then write the addresses down --------------
  await step('fund', `funding the new pool with ${FUND_GEN} GEN`, async () => {
    await send(client, pool.address, 'deposit', [], `deposit ${FUND_GEN} GEN`, FUND_GEN * ATTO);
    return { deposited_atto: String(FUND_GEN * ATTO) };
  });

  await step('record', 'writing deployed_contracts.json and .env', async () => {
    const out = {
      network: 'studionet',
      chainId: 61999,
      rpcUrl: RPC,
      deployer: account.address,
      deployedAt: new Date().toISOString(),
      note:
        'PlanRegistry is the original deployment and was deliberately kept: its code did ' +
        'not change this round and its rules carry consensus digests. OmbudsCourt and ' +
        'AdvancePool were redeployed because the court storage layout changed.',
      terms: {
        minConfidence: MIN_CONFIDENCE,
        reviewBondAtto: REVIEW_BOND_ATTO.toString(),
        advanceRateBps: ADVANCE_RATE_BPS,
        feeBps: FEE_BPS,
        maxUtilisationBps: MAX_UTILISATION_BPS,
        bandCapsAtto: BAND_CAPS_ATTO.split(','),
      },
      contracts: {
        PlanRegistry: {
          address: existing.registry,
          txHash: JSON.parse(fs.readFileSync(path.join(ROOT, 'deployed_contracts.json'), 'utf8'))
            .contracts.PlanRegistry.txHash,
        },
        OmbudsCourt: { address: court.address, txHash: court.txHash },
        AdvancePool: { address: pool.address, txHash: pool.txHash },
      },
    };
    fs.writeFileSync(
      path.join(ROOT, 'deployed_contracts.json'),
      `${JSON.stringify(out, null, 2)}\n`,
    );
    patchEnv({ OMBUDS_COURT_ADDRESS: court.address, ADVANCE_POOL_ADDRESS: pool.address });
    return { recorded: true };
  });

  if (DRY) {
    console.log('\nDry run finished. Nothing was sent.');
    return;
  }

  // ---- 9e: read it all back ---------------------------------------------
  console.log('\nReading the new deployment back');
  const cfg = await read(client, court.address, 'get_config', []);
  const ps = await read(client, pool.address, 'pool_stats', []);
  const registryOk = String(cfg.registry).toLowerCase() === String(existing.registry).toLowerCase();
  const poolOk = String(cfg.pool).toLowerCase() === String(pool.address).toLowerCase();

  console.log(`  court knows the kept registry  ${registryOk}`);
  console.log(`  court knows the new pool       ${poolOk}`);
  console.log(`  new pool TVG                   ${ps.total_value_governed_atto} atto`);
  console.log(`  new pool free                  ${ps.free_capital_atto} atto`);

  if (!registryOk || !poolOk) throw new Error('the new contracts are not wired correctly');

  console.log('\nRedeploy complete.');
  console.log(`  PlanRegistry  ${existing.registry}  (kept)`);
  console.log(`  OmbudsCourt   ${court.address}`);
  console.log(`  AdvancePool   ${pool.address}`);
  console.log('\nNow run: node scripts/check_chain.mjs');
}

main().catch((err) => {
  console.error(`\nRedeploy stopped: ${err?.message || err}`);
  console.error('State was saved. Re-run the same command to resume from the last good step.');
  process.exit(1);
});
