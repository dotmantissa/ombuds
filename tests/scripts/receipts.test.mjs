import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptOutcome, assertReceipt } from '../../scripts/receipts.mjs';
test('legacy and current execution names both require committed lifecycle', () => {
  for (const execution_result of ['SUCCESS', 'FINISHED_WITH_RETURN']) {
    assert.ok(receiptOutcome({ status: 5, consensus_data: { leader_receipt: [{ execution_result }] } }).ok);
    assert.ok(!receiptOutcome({ status: 6, consensus_data: { leader_receipt: [{ execution_result }] } }).ok);
  }
});
test('accepted errors and absent execution data never pass deployment verification', () => {
  assert.throws(() => assertReceipt({ status: 5 }, 'deploy'));
  assert.throws(() => assertReceipt({ status: 7, consensus_data: { leader_receipt: [{ execution_result: 'ERROR' }] } }, 'deploy'));
  assert.throws(() => assertReceipt({ status: 7, txExecutionResult: 1, consensus_data: { leader_receipt: [{ error: 'failure' }] } }, 'deploy'));
});


test('idle validator entries in leader_receipt are not execution outcomes', () => {
  const receipt = { status: 7, consensus_data: { leader_receipt: [
    { mode: 'leader', execution_result: 'SUCCESS' },
    { mode: 'validator', vote: 'idle', execution_result: 'ERROR', result: { status: 'contract_error', payload: 'idle' } },
  ] } };
  assert.ok(receiptOutcome(receipt).ok);
  receipt.consensus_data.leader_receipt[0].execution_result = 'ERROR';
  assert.ok(!receiptOutcome(receipt).ok);
});


test('finalization of a majority disagreement does not commit the leader result', () => {
  assert.ok(!receiptOutcome({ status: 7, result_name: 'MAJORITY_DISAGREE', consensus_data: { leader_receipt: [{ mode: 'leader', execution_result: 'SUCCESS' }] } }).ok);
  assert.ok(!receiptOutcome({ status: 7, result: 7, txExecutionResult: 1 }).ok);
});
