'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banknote, Gavel, Loader2, Scale } from 'lucide-react';

import { Panel } from '@/components/ui/primitives';
import { useApi } from '@/lib/useApi';

interface Props {
  docket: string;
  hasVerdict: boolean;
  status: string;
  advanceable: boolean;
  advanceReason: string;
  quoteAmountAtto: string | null;
  quoteLimitedBy: string | null;
}

function gen(atto: string): string {
  try {
    const value = BigInt(atto);
    const whole = value / 10n ** 18n;
    const frac = ((value % 10n ** 18n) * 100n) / 10n ** 18n;
    return `${whole}.${frac.toString().padStart(2, '0')} GEN`;
  } catch {
    return atto;
  }
}

export function CaseActions({
  docket,
  hasVerdict,
  status,
  advanceable,
  advanceReason,
  quoteAmountAtto,
  quoteLimitedBy,
}: Props) {
  const router = useRouter();
  const { call, authenticated } = useApi();
  const [busy, setBusy] = useState<null | 'adjudicate' | 'advance' | 'review'>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(kind: 'adjudicate' | 'advance' | 'review') {
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      if (kind === 'adjudicate') {
        setNote('The panel is reading the sources. This genuinely takes a few minutes.');
        await call(`/api/cases/${docket}/adjudicate`, { method: 'POST' });
      } else if (kind === 'advance') {
        await call('/api/pool', { method: 'POST', body: JSON.stringify({ docket }) });
      } else {
        await call(`/api/cases/${docket}/review`, { method: 'POST' });
      }
      router.refresh();
      setNote(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
      setNote(null);
    } finally {
      setBusy(null);
    }
  }

  const closed = status === 'SETTLED' || status === 'REJECTED';

  return (
    <Panel className="p-7">
      <p className="mono text-12 text-text-3">What you can do next</p>

      <div className="mt-4 flex flex-wrap gap-3">
        {!hasVerdict && !closed && (
          <button
            type="button"
            disabled={busy !== null || !authenticated}
            onClick={() => void run('adjudicate')}
            className="inline-flex h-11 items-center gap-2 border border-signal bg-signal px-5 text-15 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderRadius: 'var(--radius-hair)' }}
          >
            {busy === 'adjudicate' ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <Gavel size={16} aria-hidden="true" />
            )}
            Send it to a panel
          </button>
        )}

        {hasVerdict && advanceable && (
          <button
            type="button"
            disabled={busy !== null || !authenticated}
            onClick={() => void run('advance')}
            className="inline-flex h-11 items-center gap-2 border border-win px-5 text-15 font-medium disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderRadius: 'var(--radius-hair)', color: 'var(--win)' }}
          >
            {busy === 'advance' ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <Banknote size={16} aria-hidden="true" />
            )}
            {quoteAmountAtto === null
              ? 'Take the advance'
              : `Take ${gen(quoteAmountAtto)} now`}
          </button>
        )}

        {hasVerdict && !closed && status !== 'UNDER_REVIEW' && (
          <button
            type="button"
            disabled={busy !== null || !authenticated}
            onClick={() => void run('review')}
            className="inline-flex h-11 items-center gap-2 border border-line bg-surface px-5 text-15 text-text disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderRadius: 'var(--radius-hair)' }}
          >
            {busy === 'review' ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <Scale size={16} aria-hidden="true" />
            )}
            I think this is wrong
          </button>
        )}
      </div>

      {hasVerdict && !advanceable && advanceReason !== '' && (
        <p className="mt-4 text-13 text-text-2">{advanceReason}</p>
      )}

      {quoteLimitedBy !== null && advanceable && (
        <p className="mt-3 text-13 text-text-3">
          That figure is set by {quoteLimitedBy}. The rest follows when the insurer pays.
        </p>
      )}

      {status === 'UNDER_REVIEW' && (
        <p className="mt-4 text-13 text-wait">
          A bond is posted and a fresh panel has this case. The bond goes to whoever turns out to be
          right.
        </p>
      )}

      {!authenticated && (
        <p className="mt-4 text-13 text-text-3">Sign in with your email to act on this case.</p>
      )}

      {note !== null && <p className="mt-4 text-13 text-text-2">{note}</p>}
      {error !== null && <p className="mt-4 text-13 text-loss">{error}</p>}

      <p className="mt-5 text-13 text-text-3">
        Escalating sends the case to a different set of validators. It is the honest answer to
        &ldquo;what if the machine got it wrong&rdquo;, and it costs a bond so it is not free noise.
      </p>
    </Panel>
  );
}
