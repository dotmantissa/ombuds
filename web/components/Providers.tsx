'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import type { ReactNode } from 'react';

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
        // No embedded wallet is created. The relayer signs on the member's behalf, so
        // there is nothing for a member to hold, lose or be phished out of.
        embeddedWallets: {
          ethereum: { createOnLogin: 'off' },
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
      {children}
    </PrivyProvider>
  );
}

export default Providers;
