/**
 * The evidence commitment.
 *
 * `OmbudsCourt.file_case` takes a 64 hex digest and will not accept a filing without
 * one, and the digest is the only link between the paper a member is holding and the
 * record on the chain. These tests pin down where it comes from, that the browser and
 * the server compute the same one, and that a commitment which does not match the
 * document it claims to commit to is refused rather than quietly preferred.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildCaseRecord, sha256Hex } from '@/lib/deident';
import {
  FilingRefused,
  decodeBase64,
  normaliseDigest,
  resolveEvidenceCommitment,
} from '@/lib/filing';

const LETTER = [
  'Dear Member,',
  '',
  'We have completed our review of the claim submitted on your behalf for CPT 43644',
  'with a diagnosis of E66.01. Benefit denied because the requested procedure is',
  'considered not medically necessary for this member under the applicable clinical',
  'policy. Reason code 50.',
  '',
  'You may appeal this determination.',
].join('\n');

const toBase64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

test('a digest the browser computed is the one that is committed', async () => {
  const digest = await sha256Hex(LETTER);
  const commitment = await resolveEvidenceCommitment({
    evidenceSha256: digest,
    letterText: 'something else entirely, which must not be hashed',
  });

  assert.equal(commitment.sha256, digest);
  assert.equal(commitment.origin, 'browser_digest');
});

test('the browser and the server compute the same digest for the same letter', async () => {
  // The wizard calls sha256Hex on the member's machine and posts the result. When it
  // does not, the server hashes the letter itself. Both have to land on one value or the
  // record would depend on which path a given client happened to take.
  const fromBrowser = await resolveEvidenceCommitment({
    evidenceSha256: await sha256Hex(LETTER),
    letterText: LETTER,
  });
  const fromServer = await resolveEvidenceCommitment({ letterText: LETTER });

  assert.equal(fromServer.origin, 'letter_text');
  assert.equal(fromServer.sha256, fromBrowser.sha256);
  // And both equal a SHA-256 taken by something that is not this codebase.
  assert.equal(fromServer.sha256, createHash('sha256').update(LETTER, 'utf8').digest('hex'));
});

test('the document bytes are hashed when that is what was sent', async () => {
  const document = 'a scan of the denial letter, as bytes';
  const commitment = await resolveEvidenceCommitment({
    evidenceBytes: toBase64(document),
    letterText: LETTER,
  });

  assert.equal(commitment.origin, 'document_bytes');
  assert.equal(commitment.sha256, await sha256Hex(document));
  // Specifically not the letter, which is the bug this replaces: evidenceBytes used to
  // be accepted by the schema and then ignored, so the committed digest was of the
  // wrong thing entirely.
  assert.notEqual(commitment.sha256, await sha256Hex(LETTER));
});

test('a digest that does not match the document sent with it is refused', async () => {
  await assert.rejects(
    resolveEvidenceCommitment({
      evidenceSha256: await sha256Hex('the letter I meant to send'),
      evidenceBytes: toBase64('the letter I actually sent'),
      letterText: LETTER,
    }),
    (err: unknown) => {
      assert.ok(err instanceof FilingRefused);
      assert.equal(err.status, 422);
      assert.match(err.message, /does not match the document/);
      return true;
    },
  );
});

test('a digest that matches the document sent with it is accepted', async () => {
  const document = 'the letter, consistently';
  const commitment = await resolveEvidenceCommitment({
    evidenceSha256: await sha256Hex(document),
    evidenceBytes: toBase64(document),
    letterText: LETTER,
  });
  assert.equal(commitment.sha256, await sha256Hex(document));
});

test('a digest is read case insensitively and with surrounding space', async () => {
  const digest = await sha256Hex(LETTER);
  const commitment = await resolveEvidenceCommitment({
    evidenceSha256: `  ${digest.toUpperCase()}  `,
    letterText: LETTER,
  });
  assert.equal(commitment.sha256, digest);
});

test('anything that is not a SHA-256 digest is refused by name', async () => {
  for (const bad of ['', 'not a digest', 'ab'.repeat(31), 'zz'.repeat(32), `${'ab'.repeat(32)}00`]) {
    if (bad === '') continue; // an absent digest is a fallback, not a refusal
    await assert.rejects(
      resolveEvidenceCommitment({ evidenceSha256: bad, letterText: LETTER }),
      (err: unknown) => {
        assert.ok(err instanceof FilingRefused, `expected a refusal for ${JSON.stringify(bad)}`);
        assert.equal(err.status, 400);
        assert.match(err.message, /64 hex characters/);
        return true;
      },
    );
  }
});

test('normaliseDigest answers for the shapes a digest can arrive in', () => {
  const digest = 'ab'.repeat(32);
  assert.equal(normaliseDigest(digest), digest);
  assert.equal(normaliseDigest(digest.toUpperCase()), digest);
  assert.equal(normaliseDigest(` ${digest} `), digest);
  assert.equal(normaliseDigest('ab'.repeat(31)), null);
  assert.equal(normaliseDigest(null), null);
  assert.equal(normaliseDigest(42), null);
});

test('evidence bytes that are not base64 are refused rather than hashed', async () => {
  for (const bad of ['!!!!', 'abc', 'YWJj=', 'YWJ j!']) {
    await assert.rejects(
      resolveEvidenceCommitment({ evidenceBytes: bad, letterText: LETTER }),
      (err: unknown) => {
        assert.ok(err instanceof FilingRefused, `expected a refusal for ${JSON.stringify(bad)}`);
        assert.match(err.message, /base64/);
        return true;
      },
    );
  }
});

test('base64 decoding round trips bytes and tolerates whitespace', () => {
  const packed = Buffer.from('the original document', 'utf8').toString('base64');
  const wrapped = `${packed.slice(0, 8)}\n ${packed.slice(8)}`;
  assert.equal(Buffer.from(decodeBase64(wrapped)).toString('utf8'), 'the original document');
});

test('a filing with nothing to commit to is refused', async () => {
  await assert.rejects(
    resolveEvidenceCommitment({ letterText: '   ' }),
    (err: unknown) => {
      assert.ok(err instanceof FilingRefused);
      assert.equal(err.status, 400);
      assert.match(err.message, /nothing to commit to/);
      return true;
    },
  );
});

test('the resolved digest is the one that reaches the case record', async () => {
  // The end of the path: whatever this resolves to is what buildCaseRecord commits and
  // what the court is handed. buildCaseRecord validates the shape again on its own.
  const commitment = await resolveEvidenceCommitment({ letterText: LETTER });
  const built = await buildCaseRecord({
    planId: 'AETNA-COMMERCIAL-BARIATRIC',
    familyId: 'bariatric_surgery',
    state: 'TX',
    letterText: LETTER,
    denialRationale:
      'Benefit denied because the requested procedure is considered not medically ' +
      'necessary for this member under the applicable clinical policy.',
    denialReasonCode: '50',
    serviceDate: '2026-04-18',
    disputedAmount: '12400',
    sourceUrls: ['https://www.aetna.com/cpb/medical/data/100_199/0157.html'],
    evidenceSha256: commitment.sha256,
  });

  assert.equal(built.record.evidence_sha256, commitment.sha256);
  assert.match(built.record.evidence_sha256, /^[0-9a-f]{64}$/);
  // The letter itself is named in the drop list and is nowhere in the record.
  assert.ok(built.dropped.some((field) => field.field === 'letterText'));
  const serialised = JSON.stringify(built.record, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  assert.ok(!serialised.includes('Dear Member'));
});
