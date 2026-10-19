'use client';

import { usePrivy } from '@privy-io/react-auth';
import { useCallback, useMemo } from 'react';

import { evmWalletAddress } from '@/lib/address';

/**
 * Fetch with the Privy token attached.
 *
 * Every write the app makes goes through a server route that verifies this token and then
 * signs the chain transaction with the relayer key. The browser never holds a key and
 * never sees a gas prompt, which is the whole point.
 *
 * `memberAddress` is the member's own wallet address, which is where an advance and a
 * recovery surplus are paid. It is read with the same function the server verifies with,
 * so what the form shows and what the chain records cannot drift apart. It is null before
 * Privy has finished making the wallet, and the UI has to say so rather than guess.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly txHash: string | null = null) { super(message); }
}

export function useApi() {
  const { getAccessToken, authenticated, user } = usePrivy();

  const memberAddress = useMemo(() => evmWalletAddress(user), [user]);

  const call = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T> => {
      const headers = new Headers(init?.headers);
      headers.set('content-type', 'application/json');
      if (authenticated) {
        const token = await getAccessToken();
        if (token !== null && token !== '') headers.set('authorization', `Bearer ${token}`);
      }

      const res = await fetch(path, { ...init, headers });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = { error: text };
      }

      if (!res.ok) {
        const message =
          body !== null && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : `That request failed with status ${res.status}.`;
        const txHash = body && typeof body === 'object' && 'txHash' in body ? String(body.txHash) : null;
        throw new ApiError(message, res.status, txHash);
      }
      return body as T;
    },
    [authenticated, getAccessToken],
  );

  return { call, authenticated, memberAddress };
}
