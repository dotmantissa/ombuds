import assert from 'node:assert/strict';
import test from 'node:test';
import { formatGen, pageNumber, verdictChanges, type RoundVerdict } from '../lib/protocol';
import { operationOutcome } from '../lib/reconciliation';
import type { GenLayerTransaction } from 'genlayer-js/types';
test('financial displays preserve large integer amounts and show small nonzero balances', () => {
  assert.equal(formatGen('123456789012345678901234567890'), '123456789012.3456 GEN');
  assert.equal(formatGen('1'), '<0.0001 GEN');
  assert.equal(formatGen(undefined), 'Unavailable');
  assert.equal(formatGen('0'), '0.0000 GEN');
});
test('unsafe pagination input never becomes a negative or unbounded offset', () => {
  for (const input of ['-1', 'NaN', 'Infinity', '1.5', '999999999999999999999']) assert.equal(pageNumber(input), 0);
  assert.equal(pageNumber('25'), 25);
});
test('evidence changes are visible even when the decision is unchanged', () => {
  const before = { overturn_recommended: true, ground: 'MEDICAL_NECESSITY', clause_id: '0157#medical-necessity',
    recoverable_band: 2, crosses_confidence_band: true, bulletin_digest: 'source-a',
    provenance: { evidence_sha256: 'original', record_sha256: 'record-a', policy: { policy_version: 1, policy_digest: 'policy-a' } } } as RoundVerdict;
  const after = { ...before, provenance: { ...before.provenance, evidence_sha256: 'supplement' } };
  assert.deepEqual(verdictChanges(before, after), [{ label: 'Submitted evidence', before: 'original', after: 'supplement' }]);
});
test('uncommitted leader success is never reported as an executed operation', () => {
  const receipt = { status: 6, txExecutionResultName: 'FINISHED_WITH_RETURN' } as GenLayerTransaction;
  assert.equal(operationOutcome(receipt), 'PENDING');
  assert.equal(operationOutcome({ ...receipt, status: 5 }), 'EXECUTED');
  assert.equal(operationOutcome({ ...receipt, status: 7 }), 'FINALIZED');
  assert.equal(operationOutcome({ ...receipt, status: 7, txExecutionResultName: 'FINISHED_WITH_ERROR' } as GenLayerTransaction), 'FAILED');
});
