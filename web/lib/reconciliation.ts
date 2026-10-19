import type { GenLayerTransaction, TransactionHash } from 'genlayer-js/types';
import { getTransaction, readExecutionOutcome, readLifecycleStatus } from './genlayer';
import { insertCase, migrate, sql } from './db';
import { operationStore, type Operation } from './operations';
import { readDocket } from './filing';
import { caseOnChain } from './chainReads';
import { isCaseStatus } from '@/types/ombuds';

export function operationOutcome(receipt: GenLayerTransaction): string {
  const lifecycle = readLifecycleStatus(receipt);
  if (['ACCEPTED', 'FINALIZED'].includes(lifecycle)) {
    return readExecutionOutcome(receipt).ok ? (lifecycle === 'FINALIZED' ? 'FINALIZED' : 'EXECUTED') : 'FAILED';
  }
  return 'PENDING';
}
/** Re-reading receipts never signs a transaction. Interrupted filings are indexed from chain. */
export async function memberOperations(memberId: string, offset = 0) {
  await migrate();
  const rows = (await sql()`SELECT * FROM chain_operations WHERE member_id = ${memberId}
    ORDER BY created_at DESC LIMIT 25 OFFSET ${offset}`) as Operation[];
  for (const row of rows.filter((r) => r.tx_hash && ['PENDING', 'EXECUTED'].includes(r.status)).slice(0, 5)) {
    try {
      const receipt = await getTransaction(row.tx_hash as TransactionHash);
      const status = operationOutcome(receipt);
      await operationStore.update(row.id, status);
      row.status = status;
      if (row.method === 'file_case' && ['EXECUTED', 'FINALIZED'].includes(status)) {
        const docket = readDocket(receipt);
        const kase = docket ? await caseOnChain(docket) : null;
        if (docket && kase && isCaseStatus(String(kase.status))) {
          await insertCase({ docket, memberId, planId: String(kase.plan_id), familyId: String(kase.family_id),
            state: String(kase.state), cptCodes: kase.cpt_codes as string[], icd10Codes: kase.icd10_codes as string[],
            denialReasonCode: String(kase.denial_reason_code), denialRationale: String(kase.denial_rationale),
            serviceMonth: String(kase.service_month), disputedAmountAtto: BigInt(String(kase.disputed_atto)),
            evidenceSha256: String(kase.evidence_sha256), chainTx: row.tx_hash, status: String(kase.status) as never });
          row.docket = docket;
          await sql()`UPDATE chain_operations SET docket = ${docket} WHERE id = ${row.id}`;
        }
      }
    } catch { /* Keep unknown/pending visible. Transport failure is not transaction failure. */ }
  }
  const counts = (await sql()`SELECT count(*)::int AS total FROM chain_operations WHERE member_id = ${memberId}`) as Array<{ total: number }>;
  return { total: counts[0]?.total ?? 0, items: rows.map(({ id, method, docket, amount_atto, tx_hash, status, created_at }) =>
    ({ id, method, docket, amount_atto, tx_hash, status, created_at })) };
}
