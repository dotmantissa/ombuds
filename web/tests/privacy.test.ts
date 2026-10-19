import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoPhi, buildCaseRecord, normaliseDocumentText, scrubText } from '../lib/deident';
import type { CaseRecord } from '../types/ombuds';
const secret = '999-12-3456';
for (const [label, raw, hidden] of [
  ['code-shaped member identifier', 'Member ID: 43644; CPT 43775', '43644'],
  ['code-shaped diagnosis identifier', 'MRN: E66.01; diagnosis Z68.41', 'E66.01'],
  ['labelled name', 'Patient Name: Jane Example\nProcedure 43644', 'Jane Example'],
  ['HTML and invisible separators', '<p>SSN: 999\u200b-12\u200b-3456</p>', secret],
  ['unicode typography', 'SSN: ９９９–１２–３４５６', secret],
  ['international phone', 'Telephone: +44 7700 900123', '7700'],
  ['email entity', 'Email: private&#64;example.com', 'private'],
] as const) {
  test(`privacy scrub handles ${label}`, () => {
    const out = scrubText(raw);
    assert.ok(!out.clean.includes(hidden), out.clean);
    assert.ok(out.redactions.length > 0);
  });
}
test('clinical codes without identifier labels survive', () => {
  assert.equal(scrubText('CPT 43644; ICD-10 E66.01 and Z68.41').clean, 'CPT 43644; ICD-10 E66.01 and Z68.41');
});
test('sanitized output is stable across repeated scans', () => {
  const first = scrubText(`Member ID: 43644; SSN ${secret}`).clean;
  assert.equal(scrubText(first).clean, first);
});
test('PHI rejection errors never echo the detected value', () => {
  const record = { plan_id: '', family_id: '', state: 'TX', cpt_codes: [], icd10_codes: [],
    denial_reason_code: '', denial_rationale: `SSN ${secret}`, service_month: '2026-04',
    disputed_amount_atto: 1n, evidence_sha256: 'a'.repeat(64), source_urls: [] } as CaseRecord;
  assert.throws(() => assertNoPhi(record), (e: unknown) => e instanceof Error && !e.message.includes(secret));
});
test('invalid date and amount errors contain no source text', async () => {
  await assert.rejects(buildCaseRecord({ planId: 'PLAN', familyId: 'family', state: 'TX', letterText: 'CPT 43644',
    denialRationale: 'The procedure was denied for medical necessity.', denialReasonCode: '',
    serviceDate: `private ${secret}`, disputedAmount: '120', sourceUrls: [], evidenceSha256: 'a'.repeat(64) }),
    (e: unknown) => e instanceof Error && !e.message.includes(secret));
});
test('document normalization removes script bodies', () => {
  assert.ok(!normaliseDocumentText('<script>private</script><p>CPT 43644</p>').includes('private'));
});


test('a redacted labelled name passes the final record guard', () => {
  const clean = scrubText('Patient Name: Jane Example\nProcedure denied.').clean;
  const record = { plan_id: '', family_id: '', state: 'TX', cpt_codes: [], icd10_codes: [],
    denial_reason_code: '', denial_rationale: clean, service_month: '2026-04',
    disputed_amount_atto: 1n, evidence_sha256: 'a'.repeat(64), source_urls: [] } as CaseRecord;
  assert.doesNotThrow(() => assertNoPhi(record));
});
