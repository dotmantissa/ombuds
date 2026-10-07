'use client';

import { usePrivy } from '@privy-io/react-auth';
import { LogIn, LogOut } from 'lucide-react';

import { ConsensusPip } from '@/components/ConsensusProgress';
import { publicEnv } from '@/lib/env';

export function SignInButton() {
  const configured = publicEnv.privyAppId !== '';
  const privy = usePrivy();

  if (!configured) {
    return (
      <span className="mono text-12 text-text-3" title="NEXT_PUBLIC_PRIVY_APP_ID is not set">
        sign in unavailable
      </span>
    );
  }

  if (!privy.ready) {
    return (
      <span className="grid h-9 w-9 place-items-center text-text-3">
        <ConsensusPip size={15} />
        <span className="sr-only">Loading your session</span>
      </span>
    );
  }

  if (privy.authenticated) {
    const email = privy.user?.email?.address ?? 'signed in';
    return (
      <div className="flex items-center gap-2">
        <span className="mono hidden max-w-[16ch] truncate text-12 text-text-3 sm:inline" title={email}>
          {email}
        </span>
        <button
          type="button"
          onClick={() => void privy.logout()}
          className="flex h-9 items-center gap-1.5 border border-line bg-surface px-2.5 text-13 text-text-2 transition-colors hover:border-line-strong hover:text-text"
          style={{ borderRadius: 'var(--radius-hair)' }}
        >
          <LogOut size={14} aria-hidden="true" />
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => privy.login()}
      className="flex h-9 items-center gap-1.5 border border-signal bg-signal-wash px-3 text-13 font-medium text-text transition-colors hover:bg-signal hover:text-white"
      style={{ borderRadius: 'var(--radius-hair)' }}
    >
      <LogIn size={14} aria-hidden="true" />
      Sign in with email
    </button>
  );
}

export default SignInButton;
