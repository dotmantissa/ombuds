/** Live additive-schema check; isolated synthetic rows are removed in finally. */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
async function main() {
const { migrate, sql, insertCase, memberOwnsCase, upsertMember } = await import('../web/lib/db');
const { ombudsCourtAddress } = await import('../web/lib/genlayer');
const member = await upsertMember(`test:index:${randomUUID()}`, 'a'.repeat(64));
const current = ombudsCourtAddress().toLowerCase();
const other = `0x${'fe'.repeat(20)}`;
const docket = `INDEX-TEST-${randomUUID()}`;
try {
  await migrate();
  const input = { docket, memberId: member.id, planId: 'TEST', familyId: 'test', state: 'TX',
    cptCodes: ['43644'], icd10Codes: ['E66.01'], denialReasonCode: '50', denialRationale: 'Synthetic index verification.',
    serviceMonth: '2026-04', disputedAmountAtto: 1n, evidenceSha256: 'a'.repeat(64), chainTx: null, status: 'FILED' as const };
  await insertCase(input, other);
  assert.equal(await memberOwnsCase(member.id, docket), false, 'Another court cannot authorize sponsorship for this court');
  await insertCase(input, current);
  assert.equal(await memberOwnsCase(member.id, docket), true);
  const rows = await sql()`SELECT court_address FROM protocol_cases WHERE docket = ${docket}`;
  assert.ok(Array.isArray(rows)); assert.equal(rows.length, 2);
  console.log('Index migration passed; identical docket numbers remain isolated across court addresses.');
} finally {
  await sql()`DELETE FROM protocol_cases WHERE docket = ${docket} AND member_id = ${member.id}`;
  await sql()`DELETE FROM members WHERE id = ${member.id}`;
}

}
void main().catch((error: unknown) => { console.error('Index verification failed:', error instanceof Error ? `${error.name}${'keys' in error ? ': ' + String(error.keys) : ''}` : 'unknown error'); process.exitCode = 1; });
