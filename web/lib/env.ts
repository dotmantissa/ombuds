/**
 * SERVER ONLY. This module must never be imported from a client component.
 *
 * It reads the Privy app secret, the Neon connection string and the relayer
 * private key. None of those may ever reach a browser bundle. If you need the
 * Privy app id on the client, import `publicEnv` from here or read
 * `process.env.NEXT_PUBLIC_PRIVY_APP_ID` directly; everything else in this
 * file belongs to the server.
 *
 * Nothing is validated at import time. `next build` evaluates module top level
 * code while it collects page data, and a throw there would fail the build on
 * any machine without a full `.env`. So the validation sits behind a lazy
 * getter and fires on first actual use, naming the key that is missing.
 */

import { z } from 'zod';

/* ---------------------------------------------------------------------------
   Schemas, one per key
   --------------------------------------------------------------------------- */

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/**
 * Per key schemas. Kept as a flat record so a caller can validate exactly the
 * keys it needs. A route that only touches the database should not fall over
 * because a contract address has not been deployed yet.
 */
const SERVER_ENV_SHAPE = {
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.startsWith('postgres://') || value.startsWith('postgresql://'),
      { message: 'must be a postgres connection string' },
    ),

  PRIVY_APP_ID: z.string().min(1, 'must not be empty'),

  PRIVY_APP_SECRET: z.string().min(1, 'must not be empty'),

  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(HEX_PRIVATE_KEY, 'must be 0x followed by 64 hex characters'),

  GENLAYER_RPC_URL: z
    .string()
    .url('must be an absolute URL')
    .default('https://studio.genlayer.com/api'),

  PLAN_REGISTRY_ADDRESS: z
    .string()
    .regex(HEX_ADDRESS, 'must be 0x followed by 40 hex characters'),

  OMBUDS_COURT_ADDRESS: z
    .string()
    .regex(HEX_ADDRESS, 'must be 0x followed by 40 hex characters'),

  ADVANCE_POOL_ADDRESS: z
    .string()
    .regex(HEX_ADDRESS, 'must be 0x followed by 40 hex characters'),

  NEXT_PUBLIC_PRIVY_APP_ID: z.string().min(1, 'must not be empty'),
} as const;

const serverEnvSchema = z.object(SERVER_ENV_SHAPE);

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type ServerEnvKey = keyof typeof SERVER_ENV_SHAPE;

export const SERVER_ENV_KEYS = Object.keys(SERVER_ENV_SHAPE) as ServerEnvKey[];

/* ---------------------------------------------------------------------------
   Errors
   --------------------------------------------------------------------------- */

/**
 * Thrown when a required key is missing or malformed. The message names the
 * key, because the whole point is that you can fix it without reading code.
 * It never carries a value, only a key name, so this is safe to log.
 */
export class EnvError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[], detail: string) {
    super(detail);
    this.name = 'EnvError';
    this.keys = keys;
  }
}

function describe(key: string, message: string): string {
  return `  ${key}: ${message}`;
}

/* ---------------------------------------------------------------------------
   Single key access
   --------------------------------------------------------------------------- */

function assertServerSide(what: string): void {
  if (typeof window !== 'undefined') {
    throw new EnvError(
      [],
      `lib/env.ts was reached from the browser while resolving ${what}. ` +
        'This module is server only. Move the call into a route handler, a ' +
        'server component or a server action.',
    );
  }
}

const singleKeyCache = new Map<ServerEnvKey, string>();

/**
 * Read and validate one key. Throws an EnvError naming that key if it is
 * missing or the wrong shape. Cached after the first successful read.
 */
export function requireEnv(key: ServerEnvKey): string {
  const cached = singleKeyCache.get(key);
  if (cached !== undefined) return cached;

  assertServerSide(key);

  const parsed = SERVER_ENV_SHAPE[key].safeParse(process.env[key]);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? 'is invalid';
    throw new EnvError(
      [key],
      `Environment is not set up.\n${describe(key, reason)}\n` +
        'Copy .env.example to .env at the repo root and fill that key in. ' +
        'Never commit the real .env.',
    );
  }

  singleKeyCache.set(key, parsed.data);
  return parsed.data;
}

/* ---------------------------------------------------------------------------
   Whole environment access
   --------------------------------------------------------------------------- */

let fullCache: ServerEnv | null = null;

/**
 * Validate and return the whole server environment. Use this from a script or
 * a health check where you genuinely want everything present at once. Route
 * handlers are better off calling `requireEnv` for the keys they actually
 * touch, so a missing contract address does not take the database down with it.
 *
 * Throws a single EnvError listing every key that is wrong, so you fix them in
 * one pass rather than one deploy at a time.
 */
export function serverEnv(): ServerEnv {
  if (fullCache) return fullCache;

  assertServerSide('the full server environment');

  const parsed = serverEnvSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
    PRIVY_APP_ID: process.env.PRIVY_APP_ID,
    PRIVY_APP_SECRET: process.env.PRIVY_APP_SECRET,
    RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY,
    GENLAYER_RPC_URL: process.env.GENLAYER_RPC_URL,
    PLAN_REGISTRY_ADDRESS: process.env.PLAN_REGISTRY_ADDRESS,
    OMBUDS_COURT_ADDRESS: process.env.OMBUDS_COURT_ADDRESS,
    ADVANCE_POOL_ADDRESS: process.env.ADVANCE_POOL_ADDRESS,
    NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
  });

  if (!parsed.success) {
    const lines: string[] = [];
    const keys: string[] = [];
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '(root)';
      keys.push(key);
      lines.push(describe(key, issue.message));
    }
    throw new EnvError(
      keys,
      `Environment is not set up. These keys need attention:\n${lines.join('\n')}\n` +
        'Copy .env.example to .env at the repo root and fill them in. ' +
        'Never commit the real .env.',
    );
  }

  fullCache = parsed.data;
  return fullCache;
}

/**
 * True when every server key is present and well formed. Useful for a status
 * page that wants to say so without taking the request down.
 */
export function serverEnvIsReady(): boolean {
  try {
    serverEnv();
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
   The one client safe value
   --------------------------------------------------------------------------- */

/**
 * The only environment value a browser is allowed to see.
 *
 * Written as a direct static member access on purpose: that is the form Next
 * substitutes at build time. Destructuring `process.env` or indexing it with a
 * variable would leave an empty string in the client bundle.
 */
export const publicEnv = {
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? '',
} as const;

export type PublicEnv = typeof publicEnv;
