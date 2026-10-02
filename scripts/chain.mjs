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

export async function send(client, address, functionName, args, label, value = 0n) {
  const txHash = await resilient(
    () => client.writeContract({ address, functionName, args, value }),
    `submitting ${functionName}`,
  );

  const receipt = await resilient(
    () =>
      client.waitForTransactionReceipt({
        hash: txHash,
        status: 'ACCEPTED',
        interval: 3000,
        retries: 200,
      }),
    `waiting on ${functionName}`,
  );

  const exec = receipt?.data?.execution_result ?? receipt?.execution_result;
  const failed = exec && String(exec).toUpperCase().includes('ERROR');
  if (label) console.log(`  ${failed ? 'FAILED' : 'ok'}  ${label}  ${txHash}`);
  if (failed) {
    const stderr = receipt?.data?.stderr || receipt?.stderr || '';
    throw new Error(
      `${functionName} was accepted but execution failed${stderr ? `: ${String(stderr).slice(0, 400)}` : ''}`,
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
