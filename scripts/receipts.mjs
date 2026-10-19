import { executionResultNumberToName, transactionsStatusNumberToName, transactionResultNumberToName } from 'genlayer-js/types';
const statuses = transactionsStatusNumberToName;
export function receiptOutcome(receipt) {
  const raw = receipt?.consensus_data?.leader_receipt;
  const leaders = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((r) => !r.mode || r.mode === 'leader');
  const leader = leaders.at(-1);
  const status = receipt?.statusName ?? statuses[receipt?.status] ?? receipt?.status ?? 'UNKNOWN';
  const rawExecution = receipt?.txExecutionResultName ?? executionResultNumberToName[String(receipt?.txExecutionResult)] ?? leader?.execution_result ?? 'UNKNOWN';
  const execution = ({ SUCCESS: 'FINISHED_WITH_RETURN', ERROR: 'FINISHED_WITH_ERROR' })[rawExecution] ?? rawExecution;
  const consensus = receipt.resultName ?? receipt.result_name ?? transactionResultNumberToName[String(receipt.result)];
  const consensusAccepted = consensus === undefined || ['AGREE', 'MAJORITY_AGREE', 'SUCCESS'].includes(consensus);
  return { status, execution, consensus, ok: consensusAccepted && ['ACCEPTED', 'FINALIZED'].includes(status) && execution === 'FINISHED_WITH_RETURN' && !leader?.error };
}
export function assertReceipt(receipt, label) {
  const outcome = receiptOutcome(receipt);
  if (!outcome.ok) throw new Error(`${label}: lifecycle ${outcome.status}, execution ${outcome.execution}. Inspect the recorded transaction hash before retrying.`);
  return outcome;
}
