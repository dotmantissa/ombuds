/**
 * deploy/deploy.mjs
 *
 * Puts PlanRegistry, OmbudsCourt and AdvancePool on the GenLayer studio network and wires
 * them to each other, then writes the addresses to deployed_contracts.json and back into
 * .env so the web app picks them up without anybody copying a hex string by hand.
 *
 * Reads DEPLOYER_KEY from .env. Never prints it.
 */

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { setGlobalDispatcher, Agent } from 'undici';
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { chains, createClient, createAccount } from 'genlayer-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
dotenv.config({ path: path.join(root, '.env') });

const RPC = process.env.GENLAYER_RPC_URL || 'https://studio.genlayer.com/api';
const KEY = process.env.DEPLOYER_KEY;

if (!KEY) {
  console.error('DEPLOYER_KEY is missing from .env. Nothing was deployed.');
  process.exit(1);
}

const account = createAccount(KEY);
const client = createClient({ chain: chains.studionet, endpoint: RPC, account });

const ATTO = 10n ** 18n;

// Review bond: 0.25 GEN. Enough to make a frivolous escalation cost something, small
// enough that a member with a real grievance can post it.
const REVIEW_BOND_ATTO = (ATTO * 25n) / 100n;

// Pool terms. Advance 35 percent of the disputed amount, take 12 percent of the advance
// back as a fee on recovery, and never let more than 70 percent of capital be out at once.
const ADVANCE_RATE_BPS = 3500;
const FEE_BPS = 1200;
const MAX_UTILISATION_BPS = 7000;

// Per band ceilings, lowest band first, matching BAND_UPPER_USD in the court.
const BAND_CAPS_ATTO = [
  ATTO / 4n,      // under $500
  ATTO / 2n,      // $500 to $2,000
  ATTO * 1n,      // $2,000 to $7,500
  ATTO * 2n,      // $7,500 to $25,000
  ATTO * 3n,      // $25,000 to $75,000
  ATTO * 4n,      // $75,000 and above
].map((v) => v.toString()).join(',');

function log(...args) {
  console.log(...args);
}

async function addressFromTx(hash) {
  try {
    const tx = await client.getTransaction({ hash });
    return (
      tx?.data?.contract_address || tx?.contract_address || tx?.contractAddress || tx?.to || null
    );
  } catch {
    return null;
  }
}

async function deploy(name, file, args) {
  log(`\nDeploying ${name} ...`);
  const code = fs.readFileSync(path.join(root, 'contracts', file), 'utf8');
  const txHash = await client.deployContract({ code, args });
  log(`  tx ${txHash}`);

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: 'ACCEPTED',
    interval: 3000,
    retries: 200,
  });

  // ACCEPTED is a lifecycle state, not proof the code ran. A failed deploy still gets
  // accepted and simply creates no contract, so the receipt has to be read.
  const exec = receipt?.data?.execution_result ?? receipt?.execution_result;
  if (exec && String(exec).toUpperCase().includes('ERROR')) {
    throw new Error(`${name} was accepted but execution failed: ${JSON.stringify(exec)}`);
  }

  let address =
    receipt?.contract_address || receipt?.contractAddress || receipt?.data?.contract_address;
  if (!address) address = await addressFromTx(txHash);
  if (!address) throw new Error(`${name} produced no contract address. Check the receipt.`);

  log(`  ${name} is live at ${address}`);
  return { address, txHash };
}

async function write(address, functionName, args, label) {
  log(`  ${label} ...`);
  const txHash = await client.writeContract({ address, functionName, args, value: 0n });
  await client.waitForTransactionReceipt({
    hash: txHash,
    status: 'ACCEPTED',
    interval: 3000,
    retries: 200,
  });
  log(`    done, tx ${txHash}`);
  return txHash;
}

function patchEnv(values) {
  const envPath = path.join(root, '.env');
  let text = fs.readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(envPath, text, { mode: 0o600 });
  log('\nWrote the three addresses back into .env');
}

async function main() {
  log(`Deployer  ${account.address}`);
  log(`Endpoint  ${RPC}`);

  const registry = await deploy('PlanRegistry', 'plan_registry.py', []);

  const court = await deploy('OmbudsCourt', 'ombuds_court.py', [
    registry.address,
    70, // min_confidence, the line a verdict has to clear before the pool will advance
    REVIEW_BOND_ATTO.toString(),
  ]);

  const pool = await deploy('AdvancePool', 'advance_pool.py', [
    court.address,
    ADVANCE_RATE_BPS,
    FEE_BPS,
    MAX_UTILISATION_BPS,
    BAND_CAPS_ATTO,
  ]);

  log('\nWiring the three together');
  await write(court.address, 'set_pool', [pool.address], 'telling the court about the pool');

  const out = {
    network: 'studionet',
    chainId: 61999,
    rpcUrl: RPC,
    deployer: account.address,
    deployedAt: new Date().toISOString(),
    terms: {
      minConfidence: 70,
      reviewBondAtto: REVIEW_BOND_ATTO.toString(),
      advanceRateBps: ADVANCE_RATE_BPS,
      feeBps: FEE_BPS,
      maxUtilisationBps: MAX_UTILISATION_BPS,
      bandCapsAtto: BAND_CAPS_ATTO.split(','),
    },
    contracts: {
      PlanRegistry: { address: registry.address, txHash: registry.txHash },
      OmbudsCourt: { address: court.address, txHash: court.txHash },
      AdvancePool: { address: pool.address, txHash: pool.txHash },
    },
  };

  fs.writeFileSync(
    path.join(root, 'deployed_contracts.json'),
    `${JSON.stringify(out, null, 2)}\n`,
  );

  patchEnv({
    PLAN_REGISTRY_ADDRESS: registry.address,
    OMBUDS_COURT_ADDRESS: court.address,
    ADVANCE_POOL_ADDRESS: pool.address,
  });

  log('\nAll three contracts are on chain and wired.');
  log(`  PlanRegistry  ${registry.address}`);
  log(`  OmbudsCourt   ${court.address}`);
  log(`  AdvancePool   ${pool.address}`);
}

main().catch((err) => {
  console.error('\nDeploy failed:', err?.message || err);
  process.exit(1);
});
