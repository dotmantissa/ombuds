/**
 * scripts/chain.mjs
 *
 * Shared chain helper for the deploy and seed scripts and for ad hoc checks.
 * Forces IPv4 first: the studio endpoint publishes an AAAA record that is unreachable
 * from this network, and without this every call dies with ENETUNREACH.
 */

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { setGlobalDispatcher, Agent } from 'undici';
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { chains, createClient, createAccount } from 'genlayer-js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

export const RPC = process.env.GENLAYER_RPC_URL || 'https://studio.genlayer.com/api';

export function addresses() {
  return {
    registry: process.env.PLAN_REGISTRY_ADDRESS,
    court: process.env.OMBUDS_COURT_ADDRESS,
    pool: process.env.ADVANCE_POOL_ADDRESS,
  };
}

export function chainClient(keyName = 'DEPLOYER_KEY') {
  const key = process.env[keyName];
  if (!key) throw new Error(`${keyName} is missing from .env`);
  return createClient({
    chain: chains.studionet,
    endpoint: RPC,
    account: createAccount(key),
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The studio endpoint intermittently answers an RPC call with an HTML error page instead
 * of JSON, which viem surfaces as "Unexpected token '<'". That is infrastructure weather,
 * not a contract failure, so it is worth retrying rather than losing a submitted
 * transaction over.
 */
function isTransportHiccup(err) {
  const text = String(err?.message || err);
  return (
    text.includes('is not valid JSON') ||
    text.includes('Service temporarily unavailable') ||
    text.includes('Requested resource not available') ||
    text.includes('ECONNRESET') ||
    text.includes('socket hang up') ||
    text.includes('fetch failed')
  );
}

async function resilient(fn, what, attempts = 5) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isTransportHiccup(err)) throw err;
      const wait = 4000 * (i + 1);
      console.log(`    ${what} hit a transport hiccup, retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw last;
}

// The lifecycle states a transaction can end in, by their wire numbers. Needed because a
// receipt reports `status` as a number and the only ones that mean "this changed state" are
// ACCEPTED and FINALIZED.
const STATUS_BY_NUMBER = {
  0: 'UNINITIALIZED',
  1: 'PENDING',
  2: 'PROPOSING',
  3: 'COMMITTING',
  4: 'REVEALING',
  5: 'ACCEPTED',
  6: 'UNDETERMINED',
  7: 'FINALIZED',
  8: 'CANCELED',
  9: 'APPEAL_REVEALING',
  10: 'APPEAL_COMMITTING',
  11: 'READY_TO_FINALIZE',
  12: 'VALIDATORS_TIMEOUT',
  13: 'LEADER_TIMEOUT',
};

const VOTE_BY_NUMBER = {
  0: 'NOT_VOTED',
  1: 'AGREE',
  2: 'DISAGREE',
  3: 'TIMEOUT',
  4: 'DETERMINISTIC_VIOLATION',
};

const COMMITTED_STATUSES = new Set(['ACCEPTED', 'FINALIZED']);

function statusName(receipt) {
  const raw = receipt?.status ?? receipt?.data?.status;
  if (raw === undefined || raw === null) return 'MISSING';
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) return raw;
  return STATUS_BY_NUMBER[Number(raw)] ?? String(raw);
}

/** Validator votes, decoded, so a refusal can be read rather than guessed at. */
function votes(receipt) {
  const raw = (receipt?.consensus_data ?? receipt?.data?.consensus_data)?.votes;
  if (!raw) return '{}';
  const out = {};
  for (const [who, vote] of Object.entries(raw)) {
    out[String(who).slice(0, 10)] = VOTE_BY_NUMBER[Number(vote)] ?? String(vote);
  }
  return JSON.stringify(out);
}

/**
 * Submit a write and do not return until the chain has actually committed it.
 *
 * The leader's receipt is not the question. `waitForTransactionReceipt` asked for ACCEPTED
 * returns on any decided state, UNDETERMINED included, and a transaction whose validators
 * refused the leader lands there having changed nothing at all. Reading only
 * `execution_result` therefore reports a confident "ok" for a write that never happened,
 * which is exactly how a real case here was recorded as adjudicated while the chain still
 * had it as FILED. So the committed status is checked too, and a panel that would not
 * confirm its leader is an error rather than a success.
 *
 * `consensusMaxRotations` is worth passing for anything that asks a model. Rotation is the
 * protocol's own answer to a validator disagreeing, and without it one split panel ends the
 * transaction instead of replacing the panel.
 */
export async function send(client, address, functionName, args, label, value = 0n, options = {}) {
  const { consensusMaxRotations, waitRetries = 200 } = options;

  const txHash = await resilient(
    () =>
      client.writeContract({
        address,
        functionName,
        args,
        value,
        ...(consensusMaxRotations === undefined ? {} : { consensusMaxRotations }),
      }),
    `submitting ${functionName}`,
  );

  const receipt = await resilient(
    () =>
      client.waitForTransactionReceipt({
        hash: txHash,
        status: 'ACCEPTED',
        interval: 3000,
        retries: waitRetries,
      }),
    `waiting on ${functionName}`,
  );

  const exec = receipt?.data?.execution_result ?? receipt?.execution_result;
  const failed = exec && String(exec).toUpperCase().includes('ERROR');
  const status = statusName(receipt);
  const committed = COMMITTED_STATUSES.has(status);
  const ok = !failed && committed;

  if (label) console.log(`  ${ok ? 'ok' : 'FAILED'}  ${label}  ${txHash}`);

  if (failed) {
    const stderr = receipt?.data?.stderr || receipt?.stderr || '';
    throw new Error(
      `${functionName} was accepted but execution failed${stderr ? `: ${String(stderr).slice(0, 400)}` : ''}`,
    );
  }
  if (!committed) {
    throw new Error(
      `${functionName} did not commit: the leader succeeded but the transaction ended ` +
        `${status}, so no state changed. Validator votes ${votes(receipt)}.`,
    );
  }
  return txHash;
}

export async function read(client, address, functionName, args = []) {
  return resilient(
    () => client.readContract({ address, functionName, args }),
    `reading ${functionName}`,
  );
}
