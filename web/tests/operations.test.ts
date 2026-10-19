import assert from 'node:assert/strict';
import type { TransactionHash } from 'genlayer-js/types';
import test from 'node:test';
import { ExistingOperation, trackedWrite, type Operation, type OperationStore } from '../lib/operations';
import { ReceiptTimeoutError, type WriteParams, type WriteResult } from '../lib/genlayer';
const hash = `0x${'a'.repeat(64)}` as TransactionHash;
const params: WriteParams = { address: `0x${'1'.repeat(40)}`, functionName: 'advance', args: ['OMB-2026-000001'] };
function memory() {
  let row: Operation | null = null;
  const store: OperationStore = {
    async claim(input) { if (row) return { fresh: false, operation: row };
      row = { ...input, id: 'intent', tx_hash: null, status: 'SUBMITTING', created_at: '' };
      return { fresh: true, operation: row }; },
    async update(_id, status, txHash) { row = { ...row!, status, tx_hash: (txHash as typeof hash) ?? row!.tx_hash }; },
  };
  return { store, row: () => row! };
}
test('concurrent duplicate intents sign once and preserve the original hash', async () => {
  const m = memory(); let signed = 0;
  const write = async (p: WriteParams) => { signed++; await p.onSubmitted?.(hash);
    return { ok: true, txHash: hash, status: 'ACCEPTED', executionResult: 'FINISHED_WITH_RETURN' } as WriteResult; };
  await trackedWrite('member', 'request_001', params, null, m.store, write);
  await assert.rejects(trackedWrite('member', 'request_001', params, null, m.store, write), ExistingOperation);
  assert.equal(signed, 1); assert.equal(m.row().status, 'EXECUTED'); assert.equal(m.row().tx_hash, hash);
});
test('timeouts retain pending intent and prohibit a second broadcast', async () => {
  const m = memory(); const write = async (p: WriteParams): Promise<WriteResult> => {
    await p.onSubmitted?.(hash); throw new ReceiptTimeoutError(hash); };
  await assert.rejects(trackedWrite('member', 'request_002', params, null, m.store, write), ReceiptTimeoutError);
  assert.equal(m.row().status, 'PENDING');
  await assert.rejects(trackedWrite('member', 'request_002', params, null, m.store, write), ExistingOperation);
});
test('unknown broadcast and reused key with changed arguments fail closed', async () => {
  const m = memory();
  await assert.rejects(trackedWrite('member', 'request_003', params, null, m.store, async () => { throw new Error('transport'); }));
  assert.equal(m.row().status, 'UNKNOWN');
  await assert.rejects(trackedWrite('member', 'request_003', { ...params, args: ['other'] }, null, m.store),
    (e: unknown) => e instanceof ExistingOperation && e.conflict);
});


test('uncommitted and unknown execution outcomes remain pending and block retries', async () => {
  for (const [status, executionResult] of [['UNDETERMINED', 'FINISHED_WITH_RETURN'], ['FINALIZED', 'UNKNOWN']]) {
    const m = memory();
    const write = async (p: WriteParams) => { await p.onSubmitted?.(hash); return { ok: false, txHash: hash, status, executionResult } as WriteResult; };
    await assert.rejects(trackedWrite('member', 'request_004', params, null, m.store, write), ReceiptTimeoutError);
    assert.equal(m.row().status, 'PENDING');
    await assert.rejects(trackedWrite('member', 'request_004', params, null, m.store, write), ExistingOperation);
  }
});

test('the same external request key remains independent across contract deployments', async () => {
  const records = new Map<string, Operation>(); let broadcasts = 0;
  const store: OperationStore = {
    async claim(input) {
      const existing = records.get(input.request_key);
      if (existing) return { fresh: false, operation: existing };
      const row: Operation = { ...input, id: input.request_key, tx_hash: null, status: 'SUBMITTING', created_at: '' };
      records.set(input.request_key, row); return { fresh: true, operation: row };
    },
    async update(id, status, txHash) { const row = records.get(id)!; row.status = status; if (txHash) row.tx_hash = txHash as typeof hash; },
  };
  const write = async (p: WriteParams) => { broadcasts++; await p.onSubmitted?.(hash);
    return { ok: true, txHash: hash, status: 'ACCEPTED', executionResult: 'FINISHED_WITH_RETURN' } as WriteResult; };
  await trackedWrite('member', 'same_key_01', params, null, store, write);
  await trackedWrite('member', 'same_key_01', { ...params, address: `0x${'2'.repeat(40)}` }, null, store, write);
  assert.equal(broadcasts, 2); assert.equal(records.size, 2);
});
