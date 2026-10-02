'use client';

import { usePrivy } from '@privy-io/react-auth';
import { useCallback } from 'react';

/**
 * Fetch with the Privy token attached.
 *
 * Every write the app makes goes through a server route that verifies this token and then
 * signs the chain transaction with the relayer key. The browser never holds a key and
 * never sees a gas prompt, which is the whole point.
 */
export function useApi() {
  const { getAccessToken, authenticated } = usePrivy();

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
        throw new Error(message);
      }
      return body as T;
    },
    [authenticated, getAccessToken],
  );

  return { call, authenticated };
}
