'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banknote, Gavel, Scale, Stamp } from 'lucide-react';

import { ConsensusPip, ConsensusProgress } from '@/components/ConsensusProgress';
import { Panel } from '@/components/ui/primitives';
import { useApi } from '@/lib/useApi';
import { isReviewOpen } from '@/types/ombuds';

/** What a write route answers with when the chain outlasted the request. */
interface Pending {
  pending?: boolean;
  message?: string;
  txHash?: string;
}

type Action = 'adjudicate' | 'advance' | 'review' | 'resolve';

interface Props {
  docket: string;
  hasVerdict: boolean;
  status: string;
  advanceable: boolean;
  advanceReason: string;
  quoteAmountAtto: string | null;
  quoteLimitedBy: string | null;
  panelRound?: number;
}

/** What each round is deciding, said in one line while it runs. */
const JOB: Record<Action, string> = {
  adjudicate: 'A panel is deciding whether this denial survives the insurer’s own rule.',
  advance: 'The pool is checking the verdict against the chain before it moves any money.',
  review: 'The escalation is being recorded and the case handed to a fresh panel.',
  resolve: 'The appeal is being closed and the bond returned to whoever it belongs to.',
};

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
  panelRound = 1,
}: Props) {
  const router = useRouter();
  const { call, authenticated } = useApi();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [outlasted, setOutlasted] = useState<Action | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  async function run(kind: Action) {
    setBusy(kind);
    setError(null);
    setNote(null);
    setOutlasted(null);
    setTxHash(null);
    try {
      const path =
        kind === 'advance'
          ? '/api/pool'
          : kind === 'adjudicate'
            ? `/api/cases/${docket}/adjudicate`
            : kind === 'review'
              ? `/api/cases/${docket}/review`
              : `/api/cases/${docket}/review/resolve`;
      const result = await call<Pending>(path, {
        method: 'POST',
        body: kind === 'advance' ? JSON.stringify({ docket }) : undefined,
      });
      router.refresh();
      // Consensus can outlast the request. That is not a failure, so it is said
      // plainly and left on screen instead of being dressed up as an error.
      if (result?.pending === true) {
        setOutlasted(kind);
        setTxHash(result.txHash ?? null);
        setNote(result.message ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
      setNote(null);
    } finally {
      setBusy(null);
    }
  }

  const closed = status === 'SETTLED' || status === 'REJECTED';
  const reviewOpen = isReviewOpen(status);
  const heard = status === 'REVIEWED';
  const disabled = busy !== null || !authenticated;

  return (
    <Panel className="p-7">
      <p className="mono text-12 text-text-3">What you can do next</p>

      <div className="mt-4 flex flex-wrap gap-3">
        {!hasVerdict && !closed && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void run('adjudicate')}
            className="inline-flex h-11 items-center gap-2 border border-signal bg-signal px-5 text-15 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderRadius: 'var(--radius-hair)' }}
          >
            {busy === 'adjudicate' ? <ConsensusPip /> : <Gavel size={16} aria-hidden="true" />}
            Send it to a panel
          </button>
        )}

        {hasVerdict && advanceable && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void run('advance')}
            className="inline-flex h-11 items-center gap-2 border border-win px-5 text-15 font-medium disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderRadius: 'var(--radius-hair)', color: 'var(--win)' }}
          >
            {busy === 'advance' ? <ConsensusPip /> : <Banknote size={16} aria-hidden="true" />}
            {quoteAmountAtto === null ? 'Take the advance' : `Take ${gen(quoteAmountAtto)} now`}
          </button>
        )}

        {hasVerdict && !closed && !reviewOpen && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void run('review')}
            className="inline-flex h-11 items-center gap-2 border border-line bg-surface px-5 text-15 text-text disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderRadius: 'var(--radius-hair)' }}
          >
            {busy === 'review' ? <ConsensusPip /> : <Scale size={16} aria-hidden="true" />}
            I think this is wrong
          </button>
        )}

        {heard && !closed && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void run('resolve')}
            className="inline-flex h-11 items-center gap-2 border border-line bg-surface px-5 text-15 text-text disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderRadius: 'var(--radius-hair)' }}
          >
            {busy === 'resolve' ? <ConsensusPip /> : <Stamp size={16} aria-hidden="true" />}
            Close the appeal and release the bond
          </button>
        )}
      </div>

      {busy !== null && (
        <div className="mt-5">
          <ConsensusProgress job={JOB[busy]} round={panelRound} />
        </div>
      )}

      {busy === null && outlasted !== null && (
        <div className="mt-5">
          <ConsensusProgress
            job={JOB[outlasted]}
            round={panelRound}
            txHash={txHash}
            outlasted
          />
        </div>
      )}

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

      {heard && (
        <p className="mt-4 text-13 text-wait">
          The fresh panel has ruled and the bond is still held. Closing the appeal releases it. The
          contract works out who it belongs to by comparing the new ruling against the one that was
          pinned when the review opened, so nobody here decides who won.
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
