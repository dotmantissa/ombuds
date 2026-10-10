/**
 * Addresses, and the one spelling of them this app uses.
 *
 * Isomorphic on purpose: the filing wizard checks a typed payout address with the same
 * code the server binds a filing with, so the browser can refuse a typo before a request
 * is made and the server can refuse it again when one arrives anyway.
 *
 * Everything here folds to lowercase. The contracts key their maps by the lowercase form
 * and `str(gl.message.sender_address)` hands back the EIP-55 checksummed one, so a
 * comparison between the two spellings reads as correct and never matches.
 */

/** A 0x prefixed 20 byte address, already lowercased. */
export const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

/** The burn address. Nothing may be paid here: there is no key behind it. */
export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

/** The lowercase form of a 20 byte address, or null when it is not one. */
export function normaliseAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase();
  return EVM_ADDRESS.test(cleaned) ? cleaned : null;
}

export function isZeroAddress(value: unknown): boolean {
  return normaliseAddress(value) === ZERO_ADDRESS;
}

/* ---------------------------------------------------------------------------
   Picking a member's address out of a Privy user
   --------------------------------------------------------------------------- */

/** The fields of a Privy wallet this app reads. Structural, so it is testable. */
export interface WalletLike {
  address?: string | null;
  chainType?: string | null;
  type?: string | null;
}

export interface UserLike {
  wallet?: WalletLike | null;
  linkedAccounts?: ReadonlyArray<WalletLike | null | undefined> | null;
}

/**
 * The member's own Ethereum address, or null when they do not have one yet.
 *
 * `user.wallet` is whichever wallet Privy considers primary, and that can be a Solana
 * account, so the chain type and the shape are both checked rather than assumed. Linked
 * accounts are the fallback, because a member who linked an Ethereum wallet after a
 * Solana one still has an address this app can pay.
 *
 * Returning null is a real answer and the caller has to handle it. Inventing an address
 * instead — hashing the member's Privy DID into something address shaped, say — produces
 * a destination with no private key behind it, and every advance paid there is burned.
 */
export function evmWalletAddress(user: UserLike | null | undefined): string | null {
  if (user === null || user === undefined) return null;

  const candidates: Array<WalletLike | null | undefined> = [
    user.wallet,
    ...(user.linkedAccounts ?? []),
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    // An absent chainType means an older Privy payload that only ever held Ethereum.
    const chain = candidate.chainType ?? 'ethereum';
    if (chain !== 'ethereum') continue;
    const address = normaliseAddress(candidate.address);
    if (address !== null && address !== ZERO_ADDRESS) return address;
  }

  return null;
}
