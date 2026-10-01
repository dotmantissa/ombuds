/**
 * Server side Privy verification.
 *
 * Ombuds signs in with an email address and nothing else. No wallet connect, no seed
 * phrase, no browser extension, no gas prompt. Someone appealing a denied claim is
 * usually having a bad month already, and asking them to understand a private key before
 * they can argue with their insurer would be an absurd thing to do.
 *
 * What that costs us is that every chain write has to be signed by a relayer on the
 * member's behalf. So this module is the only thing standing between a request and the
 * relayer's signature, which makes it the most security sensitive file in the app.
 *
 * This module is SERVER ONLY. Importing it from a client component would ship the Privy
 * app secret to a browser.
 */

import { createHash } from 'node:crypto';
import { PrivyClient, type AuthTokenClaims } from '@privy-io/server-auth';

import { requireEnv } from './env';
import { upsertMember, type MemberRow } from './db';

if (typeof window !== 'undefined') {
  throw new Error('web/lib/privy.ts is server only and must never be imported by a client component');
}

/** Thrown for anything that should become a 401. Carries no secret and no email. */
export class AuthError extends Error {
  readonly status = 401;

  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

let cached: PrivyClient | null = null;

function client(): PrivyClient {
  if (cached === null) {
    cached = new PrivyClient(requireEnv('PRIVY_APP_ID'), requireEnv('PRIVY_APP_SECRET'));
  }
  return cached;
}

/**
 * Pull the Privy token out of a request.
 *
 * Privy sends an identity token in the `privy-id-token` header, and an access token as a
 * bearer. Either is accepted. The id token is preferred because verifying it does not
 * burn a rate limited user lookup.
 */
function readTokens(req: Request): { idToken: string | null; accessToken: string | null } {
  const idToken = req.headers.get('privy-id-token');
  const authorization = req.headers.get('authorization');
  const bearer =
    authorization !== null && authorization.toLowerCase().startsWith('bearer ')
      ? authorization.slice(7).trim()
      : null;

  return {
    idToken: idToken !== null && idToken.trim() !== '' ? idToken.trim() : null,
    accessToken: bearer !== null && bearer !== '' ? bearer : null,
  };
}

export interface VerifiedCaller {
  did: string;
  email: string | null;
  claims: AuthTokenClaims | null;
}

/**
 * Verify the caller and return their Privy DID plus, when available, their email.
 *
 * The email is used once, to derive a hash, and is never persisted or logged.
 */
export async function verifyPrivyToken(req: Request): Promise<VerifiedCaller> {
  const { idToken, accessToken } = readTokens(req);

  if (idToken === null && accessToken === null) {
    throw new AuthError('You need to be signed in to do that.');
  }

  const privy = client();

  // The identity token carries the user record, so one call does both jobs.
  if (idToken !== null) {
    try {
      const user = await privy.getUser({ idToken });
      const email = user.email?.address ?? null;
      return { did: user.id, email, claims: null };
    } catch {
      // Fall through to the access token path rather than failing outright, since an
      // expired identity token with a live access token is a normal thing to see.
    }
  }

  if (accessToken === null) {
    throw new AuthError('That sign in session is no longer valid. Please sign in again.');
  }

  let claims: AuthTokenClaims;
  try {
    claims = await privy.verifyAuthToken(accessToken);
  } catch {
    throw new AuthError('That sign in session is no longer valid. Please sign in again.');
  }

  let email: string | null = null;
  try {
    const user = await privy.getUserById(claims.userId);
    email = user.email?.address ?? null;
  } catch {
    // A rate limited or failed lookup is survivable. The DID is what identifies the
    // member; the email only ever becomes a hash.
    email = null;
  }

  return { did: claims.userId, email, claims };
}

/** SHA-256 of a lowercased, trimmed email. The address itself is never stored. */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

/**
 * Verify the caller and make sure they exist in the index, then return their row.
 *
 * Every API route that writes anything starts here.
 */
export async function requireMember(req: Request): Promise<MemberRow> {
  const caller = await verifyPrivyToken(req);
  // A member with no readable email still gets a stable hash, derived from the DID, so
  // the column is never null and still never holds an address.
  const emailHash =
    caller.email !== null
      ? hashEmail(caller.email)
      : createHash('sha256').update(`did:${caller.did}`, 'utf8').digest('hex');

  return upsertMember(caller.did, emailHash);
}

/** Turn an AuthError into a Response. Anything else becomes a flat 500 with no detail. */
export function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: 401 });
  }
  return Response.json({ error: 'Something went wrong on our side.' }, { status: 500 });
}
