import assert from 'node:assert/strict';
import test from 'node:test';
import { policyFlags, policyDifferences } from '../lib/policyMonitoring';
import type { ChainRule } from '../lib/chainReads';
const base = { retired: false, effective_from: '2026-01-01', effective_to: '2027-01-01',
  content_hash: 'a'.repeat(64), last_refreshed: '2026-10-18T10:00:00Z', revision_count: 0 } as ChainRule;
test('policy review queue distinguishes expiry, retirement, staleness and source revisions', () => {
  assert.deepEqual(policyFlags(base, '2026-10-19'), ['Current']);
  assert.ok(policyFlags({ ...base, effective_to: '2026-10-20' }, '2026-10-19').includes('Expires within 30 days'));
  assert.ok(policyFlags({ ...base, effective_to: '2026-10-01' }, '2026-10-19').includes('Expired'));
  assert.deepEqual(policyFlags({ ...base, retired: true }, '2026-10-19'), ['Retired']);
  assert.ok(policyFlags({ ...base, last_refreshed: '2026-01-01' }, '2026-10-19').includes('Source check over 30 days old'));
  assert.ok(policyFlags({ ...base, content_hash: '' }, '2026-10-19').includes('Source not fingerprinted'));
});
test('source differences distinguish changed document from a monitoring timestamp', () => {
  assert.deepEqual(policyDifferences({ content_hash: 'a', last_refreshed: 'old' }, { content_hash: 'a', last_refreshed: 'new' }), []);
  assert.deepEqual(policyDifferences({ content_hash: 'a' }, { content_hash: 'b' }), [{ field: 'content_hash', before: '"a"', after: '"b"' }]);
});
