/**
 * The GenLayer client.
 *
 * SERVER ONLY in practice. `readClient` would work anywhere, but this module
 * imports `lib/env.ts` for the endpoint and the relayer key, so treat the whole
 * file as server side and call it from a route handler or a server action.
 *
 * Ombuds is gasless and the member never sees a wallet. A server side relayer
 * holds the key and signs every chain write, which is why `relayerClient`
 * refuses to exist in a browser.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING TO UNDERSTAND BEFORE EDITING THIS FILE
 *
 * A GenLayer transaction has TWO independent outcomes and they are easy to
 * confuse.
 *
 *   Lifecycle status   PENDING, PROPOSING, COMMITTING, ACCEPTED, FINALIZED ...
 *                      This is what consensus did with the transaction.
 *
 *   Execution result   FINISHED_WITH_RETURN, FINISHED_WITH_ERROR, NOT_VOTED
 *                      This is what the contract code actually did.
 *
 * A transaction can reach ACCEPTED or even FINALIZED with an execution result
 * of FINISHED_WITH_ERROR. The validators agreed, unanimously and correctly,
 * that the contract threw. Lifecycle ACCEPTED does NOT mean the write worked.
 *
 * So `ok` in the result of `writeContract` below reflects the EXECUTION result
 * and never the lifecycle status. Reading it the other way round would have
 * Ombuds telling a member their appeal was filed when the contract rejected it,
 * which is the worst bug this codebase could ship.
 * ---------------------------------------------------------------------------
 */

import { createAccount, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import {
  ExecutionResult,
  TransactionStatus,
  executionResultNumberToName,
} from 'genlayer-js/types';
import type {
  CalldataEncodable,
  GenLayerChain,
  GenLayerClient,
  GenLayerTransaction,
  LeaderReceipt,
  TransactionHash,
} from 'genlayer-js/types';

import { requireEnv } from './env';

/** A 0x prefixed address, the shape genlayer-js and viem both want. */
export type ChainAddress = `0x${string}`;

type Client = GenLayerClient<GenLayerChain>;

/* ---------------------------------------------------------------------------
   Node networking
   --------------------------------------------------------------------------- */

let networkingPrepared = false;

/**
 * Force IPv4 when running on node.
 *
 * The studio endpoint publishes an AAAA record that hangs rather than refusing
 * on a fair number of development setups, WSL2 in particular, so a request that
 * should take 200ms sits there until it times out. Pinning the resolver order
 * and handing undici a dispatcher that only dials IPv4 makes it deterministic.
 *
 * Guarded three ways. It is skipped in the browser, skipped on the edge runtime
 * which has no node builtins, and the specifiers are held in variables with
 * bundler ignore comments so neither webpack nor turbopack tries to resolve
 * `node:dns` while building a client bundle.
 */
async function prepareNodeNetworking(): Promise<void> {
  if (networkingPrepared) return;
  networkingPrepared = true;

  if (typeof window !== 'undefined') return;
  if (process.env.NEXT_RUNTIME === 'edge') return;

  try {
    const dnsSpecifier = 'node:dns';
    const dns = (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ dnsSpecifier
    )) as typeof import('node:dns');
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    // No node:dns here. Nothing to pin, and nothing worth failing a request over.
  }

  try {
    const undiciSpecifier = 'undici';
    const undici = (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ undiciSpecifier
    )) as typeof import('undici');
    undici.setGlobalDispatcher(
      new undici.Agent({ connect: { family: 4 } }),
    );
  } catch {
    // Same again. The DNS ordering above already does most of the work.
  }
}

/* ---------------------------------------------------------------------------
   Addresses
   --------------------------------------------------------------------------- */

/**
 * The three deployed contracts. Accessor functions rather than constants, so a
 * missing address is an error at the point of use with the key named, instead
 * of an empty string that quietly becomes a call to nowhere.
 */
export function planRegistryAddress(): ChainAddress {
  return requireEnv('PLAN_REGISTRY_ADDRESS') as ChainAddress;
}

export function ombudsCourtAddress(): ChainAddress {
  return requireEnv('OMBUDS_COURT_ADDRESS') as ChainAddress;
}

export function advancePoolAddress(): ChainAddress {
  return requireEnv('ADVANCE_POOL_ADDRESS') as ChainAddress;
}

/** The studionet RPC endpoint. Defaults to the studio URL via env.ts. */
export function rpcEndpoint(): string {
  return requireEnv('GENLAYER_RPC_URL');
}

/* ---------------------------------------------------------------------------
   Clients
   --------------------------------------------------------------------------- */

let readCache: Client | null = null;

/**
 * A read only client against studionet. No account, so it cannot sign
 * anything, which is the point: every read path in the app uses this one.
 */
export async function readClient(): Promise<Client> {
  if (readCache) return readCache;
  await prepareNodeNetworking();
  readCache = createClient({
    chain: studionet,
    endpoint: rpcEndpoint(),
  });
  return readCache;
}

let relayerCache: Client | null = null;

/**
 * The relayer client, which holds the key that signs every chain write.
 *
 * Server only, and it throws rather than degrades if it ever finds itself in a
 * browser. The whole email only auth design rests on this key never leaving the
 * server, so a soft failure here would be the wrong kind of forgiving.
 */
export async function relayerClient(): Promise<Client> {
  if (typeof window !== 'undefined') {
    throw new Error(
      'relayerClient was called in the browser. The relayer private key is ' +
        'server only and must never reach a client bundle. Move this call into ' +
        'a route handler or a server action.',
    );
  }

  if (relayerCache) return relayerCache;
  await prepareNodeNetworking();

  const account = createAccount(requireEnv('RELAYER_PRIVATE_KEY') as ChainAddress);

  relayerCache = createClient({
    chain: studionet,
    endpoint: rpcEndpoint(),
    account,
  });
  return relayerCache;
}

/** The relayer's own address, which is the sender of every write. */
export async function relayerAddress(): Promise<ChainAddress> {
  const client = await relayerClient();
  return (client.account?.address ?? '0x') as ChainAddress;
}

/* ---------------------------------------------------------------------------
   Reads
   --------------------------------------------------------------------------- */

export interface ReadParams {
  address: ChainAddress;
  functionName: string;
  args?: CalldataEncodable[];
}

/**
 * Call a view method.
 *
 * `T` is a promise from the caller about what the contract returns, not
 * something this function can check. Contract return shapes are decoded from
 * calldata at runtime, so validate anything that matters before you trust it.
 */
export async function readContract<T>(params: ReadParams): Promise<T> {
  const client = await readClient();
  const raw = await client.readContract({
    address: params.address,
    functionName: params.functionName,
    args: params.args ?? [],
  });
  return raw as unknown as T;
}

/* ---------------------------------------------------------------------------
   Execution outcome
   --------------------------------------------------------------------------- */

/** What the contract code did, as opposed to what consensus did. */
export interface ExecutionOutcome {
  /** True only when the contract ran to completion and returned. */
  ok: boolean;
  /** The execution result name, or 'UNKNOWN' when the receipt does not say. */
  executionResult: string;
  /** The error the contract raised, when there is one. */
  error: string | null;
}

/**
 * The leader receipts off a transaction, normalised to an array.
 *
 * The declared type is an array, but the node has been known to hand back a
 * single object, so this takes the value as unknown and copes with both rather
 * than throwing on a shape it could have handled.
 */
function leaderReceipts(receipt: GenLayerTransaction): LeaderReceipt[] {
  const raw: unknown = receipt.consensus_data?.leader_receipt;
  if (Array.isArray(raw)) return raw as LeaderReceipt[];
  if (raw !== null && typeof raw === 'object') return [raw as LeaderReceipt];
  return [];
}

/** The last leader receipt, which is the one from the deciding round. */
function lastLeaderReceipt(
  receipt: GenLayerTransaction,
): LeaderReceipt | undefined {
  const all = leaderReceipts(receipt);
  return all.length > 0 ? all[all.length - 1] : undefined;
}

function executionNameFromNumber(value: number): string | null {
  const table: Record<string, ExecutionResult> = executionResultNumberToName;
  return table[String(value)] ?? null;
}

/**
 * Work out whether the contract actually succeeded.
 *
 * Three sources, in order of how much they can be trusted:
 *   1. `txExecutionResultName`, the decoded name, when the node sends it.
 *   2. `txExecutionResult`, the raw number, mapped through the SDK's table.
 *   3. The leader receipt's own `execution_result` string.
 *
 * If none of them say anything, the answer is not ok. An unknown outcome is
 * treated as a failure on purpose: this decides whether a member gets told
 * their case was filed, and silence is not a yes.
 */
export function readExecutionOutcome(
  receipt: GenLayerTransaction,
): ExecutionOutcome {
  const leader = lastLeaderReceipt(receipt);
  const error = leader?.error ? String(leader.error) : null;

  let name: string | null = receipt.txExecutionResultName ?? null;

  if (!name && typeof receipt.txExecutionResult === 'number') {
    name = executionNameFromNumber(receipt.txExecutionResult);
  }

  if (!name && leader?.execution_result) {
    name = String(leader.execution_result);
  }

  if (!name) {
    return {
      ok: false,
      executionResult: 'UNKNOWN',
      error:
        error ??
        'the receipt carried no execution result, so the write cannot be ' +
          'reported as successful',
    };
  }

  const ok = name === ExecutionResult.FINISHED_WITH_RETURN && error === null;
  return { ok, executionResult: name, error };
}

/** The lifecycle status off a receipt, as a readable name. */
export function readLifecycleStatus(receipt: GenLayerTransaction): string {
  if (receipt.statusName) return String(receipt.statusName);
  if (typeof receipt.status === 'string') return receipt.status;
  if (typeof receipt.status === 'number') return ({ 5: 'ACCEPTED', 7: 'FINALIZED' } as Record<number, string>)[receipt.status] ?? `status:${receipt.status}`;
  return 'UNKNOWN';
}

/* ---------------------------------------------------------------------------
   Writes
   --------------------------------------------------------------------------- */

export interface WriteParams {
  address: ChainAddress;
  functionName: string;
  args?: CalldataEncodable[];
  /**
   * Native value to send. Ombuds is gasless and none of the three contracts
   * take a payment, so this is zero unless you have a very good reason.
   */
  value?: bigint;
  /** Persist the hash immediately after broadcast, before waiting for consensus. */
  onSubmitted?: (hash: TransactionHash) => Promise<void>;
}

export interface WriteResult {
  txHash: TransactionHash;
  receipt: GenLayerTransaction;
  /**
   * EXECUTION success, not lifecycle status. True only when the contract ran
   * to completion and returned without raising. Read the file header before
   * changing how this is derived.
   */
  ok: boolean;
  /** The consensus lifecycle status, for display and for logs. */
  status: string;
  /** FINISHED_WITH_RETURN, FINISHED_WITH_ERROR, NOT_VOTED or UNKNOWN. */
  executionResult: string;
  /** The error the contract raised, when it raised one. */
  error: string | null;
}

/**
 * How long to wait for a receipt.
 *
 * This ceiling is set by the host, not by consensus. A Vercel function is killed
 * at 300 seconds, and when the host does the killing the member gets a gateway
 * error with no transaction hash in it, which is the one thing they actually
 * need. So the wait gives up on its own at 255 seconds and leaves the remaining
 * budget for submitting, reading the verdict back and writing the index row.
 *
 * `WAIT_RETRIES` is deliberately set past the deadline. The SDK should never be
 * the thing that gives up first, because then its error, and not ours, is what
 * the caller has to interpret.
 */
export const WAIT_INTERVAL_MS = 3000;
export const WAIT_RETRIES = 100;
export const WAIT_DEADLINE_MS = 255_000;

/**
 * The wait gave up before consensus landed.
 *
 * This is not a failed write. The transaction is on chain and the validators are
 * still working, so it carries the hash and callers turn it into a "still
 * sitting" answer rather than an error. Every verdict is re-read from the
 * contract rather than parsed out of a receipt, so a case page shows the result
 * as soon as it exists whether or not anybody was still holding a request open
 * when it landed.
 */
export class ReceiptTimeoutError extends Error {
  readonly txHash: TransactionHash;

  constructor(txHash: TransactionHash) {
    super(
      `The panel has not reached a decision in the ${Math.round(WAIT_DEADLINE_MS / 1000)} ` +
        'seconds this request can stay open. The transaction is on chain and consensus is ' +
        `still running. Transaction ${txHash}.`,
    );
    this.name = 'ReceiptTimeoutError';
    this.txHash = txHash;
  }
}

/**
 * Submit a write and wait for the receipt.
 *
 * Waits for lifecycle ACCEPTED, then reads the EXECUTION result off the receipt
 * and reports that as `ok`. A transaction that reaches ACCEPTED with
 * FINISHED_WITH_ERROR comes back with `ok: false` and the contract's own error
 * message in `error`, which is the whole reason this function exists rather
 * than callers using the SDK directly.
 */
export async function writeContract(
  params: WriteParams,
): Promise<WriteResult> {
  const client = await relayerClient();

  const submitted = await client.writeContract({
    address: params.address,
    functionName: params.functionName,
    args: params.args ?? [],
    value: params.value ?? 0n,
  });

  const txHash = submitted as TransactionHash;
  await params.onSubmitted?.(txHash);

  // Our own deadline decides when to stop waiting, so that a real transport
  // failure from the SDK still propagates as itself instead of being reported
  // to a member as "still running".
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReceiptTimeoutError(txHash)), WAIT_DEADLINE_MS);
  });

  let receipt: GenLayerTransaction;
  try {
    receipt = await Promise.race([
      client.waitForTransactionReceipt({
        hash: txHash,
        status: TransactionStatus.ACCEPTED,
        interval: WAIT_INTERVAL_MS,
        retries: WAIT_RETRIES,
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }

  const outcome = readExecutionOutcome(receipt);

  return {
    txHash,
    receipt,
    ok: outcome.ok && ['ACCEPTED', 'FINALIZED'].includes(readLifecycleStatus(receipt)),
    status: readLifecycleStatus(receipt),
    executionResult: outcome.executionResult,
    error: outcome.error,
  };
}

/**
 * Like `writeContract`, but throws when the contract did not succeed.
 *
 * For the call sites that have nothing sensible to do with a failure and would
 * rather the request turned into a 500 than carry on as though the write landed.
 */
export async function writeContractOrThrow(
  params: WriteParams,
): Promise<WriteResult> {
  const result = await writeContract(params);
  if (!result.ok) {
    throw new Error(
      `${params.functionName} did not succeed on chain. ` +
        `Lifecycle status ${result.status}, execution ${result.executionResult}. ` +
        `Transaction ${result.txHash}.` +
        (result.error ? ` Contract said: ${result.error}` : ''),
    );
  }
  return result;
}

/** Re-read a transaction. Used to turn a tx hash back into a verdict. */
export async function getTransaction(
  hash: TransactionHash,
): Promise<GenLayerTransaction> {
  const client = await readClient();
  return client.getTransaction({ hash });
}
