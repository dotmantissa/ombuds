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

export async function send(client, address, functionName, args, label) {
  const txHash = await client.writeContract({ address, functionName, args, value: 0n });
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: 'ACCEPTED',
    interval: 3000,
    retries: 200,
  });
  const exec = receipt?.data?.execution_result ?? receipt?.execution_result;
  const failed = exec && String(exec).toUpperCase().includes('ERROR');
  if (label) console.log(`  ${failed ? 'FAILED' : 'ok'}  ${label}  ${txHash}`);
  if (failed) throw new Error(`${functionName} was accepted but execution failed`);
  return txHash;
}
