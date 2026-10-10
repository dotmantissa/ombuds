/**
 * Who a filing belongs to, and who gets paid.
 *
 * Ombuds is relayed: the member signs nothing, and a server side key signs every write.
 * So the address recorded on the case does not come from the transaction signer, it comes
 * from the verified session, and these tests cover the two steps in that chain:
 *
 *   evmWalletAddress      reading the member's own address out of a verified Privy user
 *   resolvePayoutAddress  deciding which address the court is told about
 *
 * There are two ways to get this wrong and both cost the member their money. Recording
 * the relayer makes the relayer the owner of the case and the payee of the advance.
 * Recording something merely address shaped — a hash of the member's Privy DID, say —
 * pays the advance to an address with no private key behind it, where it stays forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { ZERO_ADDRESS, evmWalletAddress, isZeroAddress, normaliseAddress } from '@/lib/address';
import { FilingRefused, resolvePayoutAddress } from '@/lib/filing';

const MEMBER_WALLET = '0x7a3fC4dA91B20eF5C8d1e2A4b6C8D0e2F4a6B8c0';
const NOMINATED = '0x1111111111111111111111111111111111111111';
const RELAYER = '0x9999999999999999999999999999999999999999';

/* ----------------------------------------------------------------- the address itself */

test('an address is normalised to the one spelling the contracts key by', () => {
  assert.equal(normaliseAddress(MEMBER_WALLET), MEMBER_WALLET.toLowerCase());
  assert.equal(normaliseAddress(`  ${MEMBER_WALLET}  `), MEMBER_WALLET.toLowerCase());
  assert.equal(normaliseAddress(MEMBER_WALLET.toUpperCase().replace('0X', '0x')), MEMBER_WALLET.toLowerCase());
});

test('anything that is not a 20 byte address reads as null', () => {
  for (const bad of [
    '',
    '0x',
    'not-an-address',
    MEMBER_WALLET.slice(0, -1),
    `${MEMBER_WALLET}0`,
    MEMBER_WALLET.replace('7a', 'zz'),
    MEMBER_WALLET.slice(2), // no 0x
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(normaliseAddress(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('the zero address is recognised for what it is', () => {
  assert.equal(ZERO_ADDRESS, `0x${'0'.repeat(40)}`);
  assert.ok(isZeroAddress(ZERO_ADDRESS));
  assert.ok(isZeroAddress(ZERO_ADDRESS.toUpperCase().replace('0X', '0x')));
  assert.ok(!isZeroAddress(MEMBER_WALLET));
});

/* ------------------------------------------- reading the member's address out of Privy */

test("the member's embedded wallet is the address used", () => {
  const user = { wallet: { address: MEMBER_WALLET, chainType: 'ethereum' } };
  assert.equal(evmWalletAddress(user), MEMBER_WALLET.toLowerCase());
});

test('a Privy payload with no chainType is treated as Ethereum', () => {
  assert.equal(
    evmWalletAddress({ wallet: { address: MEMBER_WALLET } }),
    MEMBER_WALLET.toLowerCase(),
  );
});

test('a Solana primary wallet does not become an Ethereum payout address', () => {
  // `user.wallet` is whichever wallet Privy considers primary, and base58 is not an
  // address this chain can pay. Reading it anyway would hand the court a filer the
  // contract then refuses, or worse, truncate into something that validates.
  const user = {
    wallet: { address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PQkcZ1h', chainType: 'solana' },
  };
  assert.equal(evmWalletAddress(user), null);
});

test('an Ethereum wallet is found behind a Solana primary one', () => {
  const user = {
    wallet: { address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PQkcZ1h', chainType: 'solana' },
    linkedAccounts: [
      { address: 'not-an-address', chainType: 'ethereum' },
      { address: MEMBER_WALLET, chainType: 'ethereum' },
    ],
  };
  assert.equal(evmWalletAddress(user), MEMBER_WALLET.toLowerCase());
});

test('a member with no wallet yet reads as null rather than as something invented', () => {
  for (const user of [
    null,
    undefined,
    {},
    { wallet: null },
    { wallet: { address: null } },
    { wallet: { address: '' } },
    { wallet: { address: ZERO_ADDRESS, chainType: 'ethereum' } },
    { linkedAccounts: [] },
    { linkedAccounts: [null, undefined] },
  ]) {
    assert.equal(evmWalletAddress(user), null, `expected null for ${JSON.stringify(user)}`);
  }
});

/* --------------------------------------------------------- deciding who the money goes to */

test("a filing defaults to the member's own address", () => {
  const bound = resolvePayoutAddress({ memberAddress: MEMBER_WALLET });
  assert.equal(bound, MEMBER_WALLET.toLowerCase());
  assert.notEqual(bound, RELAYER);
});

test('a nominated payout address wins over the default', () => {
  assert.equal(
    resolvePayoutAddress({ payoutAddress: NOMINATED, memberAddress: MEMBER_WALLET }),
    NOMINATED,
  );
});

test('a blank nomination falls through to the member rather than refusing', () => {
  for (const blank of ['', '   ', undefined, null]) {
    assert.equal(
      resolvePayoutAddress({ payoutAddress: blank, memberAddress: MEMBER_WALLET }),
      MEMBER_WALLET.toLowerCase(),
    );
  }
});

test('a nominated address that is not an address is refused by name', () => {
  assert.throws(
    () => resolvePayoutAddress({ payoutAddress: '0xnope', memberAddress: MEMBER_WALLET }),
    (err: unknown) => {
      assert.ok(err instanceof FilingRefused);
      assert.equal(err.status, 400);
      assert.match(err.message, /40 hex characters/);
      return true;
    },
  );
});

test('the zero address is refused whichever way it arrives', () => {
  assert.throws(
    () => resolvePayoutAddress({ payoutAddress: ZERO_ADDRESS, memberAddress: MEMBER_WALLET }),
    (err: unknown) => {
      assert.ok(err instanceof FilingRefused);
      assert.match(err.message, /can ever be collected/);
      return true;
    },
  );
  assert.throws(
    () => resolvePayoutAddress({ memberAddress: ZERO_ADDRESS }),
    (err: unknown) => {
      assert.ok(err instanceof FilingRefused);
      assert.match(err.message, /do not have an address to pay you at/);
      return true;
    },
  );
});

test('a member with no address is told so, not quietly bound to one', () => {
  // This is the case the previous version papered over by hashing the member's Privy DID
  // into something address shaped. That address validates, the court accepts it, the pool
  // pays an advance to it, and nobody can ever spend it.
  const did = 'did:privy:clxyz0000000000000000000';
  const derived = `0x${createHash('sha256').update(`ombuds:member:${did}`, 'utf8').digest('hex').slice(24)}`;
  assert.match(derived, /^0x[0-9a-f]{40}$/); // it really does look like an address

  for (const absent of [null, undefined, '']) {
    assert.throws(
      () => resolvePayoutAddress({ memberAddress: absent }),
      (err: unknown) => {
        assert.ok(err instanceof FilingRefused);
        assert.equal(err.status, 400);
        assert.match(err.message, /Sign out and sign in again|payout address on the form/);
        return true;
      },
    );
  }
});
