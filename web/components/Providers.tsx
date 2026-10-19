'use client';

import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import type { ReactNode } from 'react';

import { SessionContext } from '@/lib/session';
import { evmWalletAddress } from '@/lib/address';
import { publicEnv } from '@/lib/env';

/**
 * Email only sign in.
 *
 * No wallet connect, no seed phrase, no browser extension, no gas. Someone appealing a
 * denied claim is already having a bad month, and a key ceremony is not a reasonable
 * thing to put between them and their insurer. Privy makes the account; a server side
 * relayer signs every chain write on their behalf.
 */
export function Providers({ children }: { children: ReactNode }) {
  const appId = publicEnv.privyAppId;

  if (appId === '') {
    // Without an app id there is nothing to sign in to. The site still renders, which
    // matters for the public docket, and the sign in button says what is wrong.
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email'],
        // An embedded wallet is created on first sign in, and the member never sees it.
        // There is no seed phrase to lose and no extension to install: the account is
        // recovered by signing in with the same email, and the relayer still pays the gas.
        //
        // It is here because the pool pays an advance to an address, and that address has
        // to be one the member can actually spend from. A case filed against an address
        // nobody holds the key to is an advance paid into a hole.
        embeddedWallets: {
          ethereum: { createOnLogin: 'users-without-wallets' },
          solana: { createOnLogin: 'off' },
        },
        appearance: {
          theme: 'dark',
          accentColor: '#a238ff',
          logo: '/mark.svg',
          walletList: [],
        },
      }}
    >
      <SessionBridge>{children}</SessionBridge>
    </PrivyProvider>
  );
}

function SessionBridge({ children }: { children: ReactNode }) {
  const privy = usePrivy();
  return <SessionContext.Provider value={{ ready: privy.ready, authenticated: privy.authenticated,
    memberAddress: evmWalletAddress(privy.user), email: privy.user?.email?.address ?? null,
    getAccessToken: privy.getAccessToken, login: privy.login, logout: privy.logout }}>{children}</SessionContext.Provider>;
}

export default Providers;
