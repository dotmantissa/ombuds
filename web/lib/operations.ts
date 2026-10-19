/** Durable submission intents. Unknown broadcast outcomes always require reconciliation. */
import { createHash } from 'node:crypto';
import type { TransactionHash } from 'genlayer-js/types';
import { migrate, sql } from './db';
import { ReceiptTimeoutError, writeContract, type WriteParams, type WriteResult } from './genlayer';

export interface Operation {
  id: string; member_id: string; request_key: string; fingerprint: string;
  contract_address: string; method: string; docket: string | null;
  amount_atto: string; tx_hash: `0x${string}` | null; status: string; created_at: string;
}
export interface OperationStore {
  claim(input: Omit<Operation, 'id' | 'tx_hash' | 'status' | 'created_at'>): Promise<{ fresh: boolean; operation: Operation }>;
  update(id: string, status: string, txHash?: string): Promise<void>;
}
export const operationStore: OperationStore = {
  async claim(input) {
    await migrate();
    const inserted = (await sql()`INSERT INTO chain_operations
      (member_id, request_key, fingerprint, contract_address, method, docket, amount_atto)
      VALUES (${input.member_id}, ${input.request_key}, ${input.fingerprint}, ${input.contract_address},
      ${input.method}, ${input.docket}, ${input.amount_atto})
      ON CONFLICT (member_id, request_key) DO NOTHING RETURNING *`) as Operation[];
    const rows = inserted.length ? inserted : (await sql()`SELECT * FROM chain_operations
      WHERE member_id = ${input.member_id} AND request_key = ${input.request_key}`) as Operation[];
    return { fresh: inserted.length > 0, operation: rows[0] as Operation };
  },
  async update(id, status, txHash) {
    await sql()`UPDATE chain_operations SET status = ${status}, tx_hash = COALESCE(${txHash ?? null}, tx_hash),
      updated_at = now() WHERE id = ${id}`;
  },
};

export class ExistingOperation extends Error {
  constructor(readonly operation: Operation, readonly conflict = false) {
    super(conflict ? 'This request key was already used for different details.' :
      'This operation was already submitted. Check its receipt before trying anything else.');
  }
}

export async function trackedWrite(
  memberId: string, requestKey: string, params: WriteParams, docket: string | null = null,
  store: OperationStore = operationStore, write: (params: WriteParams) => Promise<WriteResult> = writeContract,
): Promise<WriteResult> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestKey)) throw new Error('A valid request key is required.');
  const fingerprint = createHash('sha256').update(JSON.stringify({
    address: params.address.toLowerCase(), method: params.functionName,
    args: params.args ?? [], value: String(params.value ?? 0n),
  }, (_k, v) => typeof v === 'bigint' ? v.toString() : v)).digest('hex');
  const claim = await store.claim({ member_id: memberId, request_key: `${params.address.toLowerCase()}:${requestKey}`, fingerprint,
    contract_address: params.address.toLowerCase(), method: params.functionName, docket, amount_atto: String(params.value ?? 0n) });
  if (!claim.fresh) throw new ExistingOperation(claim.operation, claim.operation.fingerprint !== fingerprint);
  let hash: string | undefined;
  try {
    const result = await write({ ...params, onSubmitted: async (txHash) => {
      hash = txHash;
      await store.update(claim.operation.id, 'PENDING', txHash);
    } });
    if (!['ACCEPTED', 'FINALIZED'].includes(result.status) || result.executionResult === 'UNKNOWN') {
      await store.update(claim.operation.id, 'PENDING', result.txHash);
      throw new ReceiptTimeoutError(result.txHash);
    }
    await store.update(claim.operation.id, result.ok ? (result.status === 'FINALIZED' ? 'FINALIZED' : 'EXECUTED') : 'FAILED', result.txHash);
    return result;
  } catch (error) {
    const txHash = error instanceof ReceiptTimeoutError ? error.txHash : hash;
    await store.update(claim.operation.id, txHash ? 'PENDING' : 'UNKNOWN', txHash).catch(() => undefined);
    // Even a database failure AFTER broadcast must keep the hash available to the caller.
    if (txHash) throw new ReceiptTimeoutError(txHash as TransactionHash);
    throw error;
  }
}

export function existingOperationResponse(error: unknown): Response | null {
  if (!(error instanceof ExistingOperation)) return null;
  if (error.operation.status === 'FAILED' && !error.conflict) return Response.json({ error: 'The previous transaction failed. You may start a new attempt after reviewing its receipt.', txHash: error.operation.tx_hash }, { status: 422 });
  return Response.json({ pending: !['FAILED', 'EXECUTED', 'FINALIZED'].includes(error.operation.status),
    status: error.operation.status, txHash: error.operation.tx_hash, operationId: error.operation.id,
    message: error.message }, { status: error.conflict ? 409 : 202 });
}
