'use client';

import { useEffect, useState } from 'react';

import { Mark } from '@/components/brand/Mark';

/**
 * What a pending write looks like.
 *
 * A spinner says "wait". It does not say what is being waited on, and on this product
 * the thing being waited on is the entire argument for why the verdict is worth
 * anything. A panel of independent validators is each re-fetching the insurer's
 * bulletin, re-auditing the codes, deciding again, and then having to agree before a
 * single character reaches state. That takes minutes, and a member staring at a
 * rotating circle for three minutes has been told nothing.
 *
 * So this draws the mechanism instead: the leader, the validators behind it, the round
 * travelling across them, and the stages a GenLayer transaction genuinely walks through
 * on its way to finality.
 *
 * Honesty rule applied throughout. The ladder below names the real lifecycle a
 * transaction moves through and is labelled as the route, not as a live readout. The
 * only things stated as fact are the ones actually known: how long this has been
 * running, and the transaction hash once the chain has given us one.
 */

/** The GenLayer transaction lifecycle, in the order a write walks it. */
const STAGES: ReadonlyArray<{ chain: string; plain: string }> = [
  { chain: 'PROPOSING', plain: 'the leader reads the sources and proposes' },
  { chain: 'COMMITTING', plain: 'validators run the job again and seal a vote' },
  { chain: 'REVEALING', plain: 'the votes are opened together' },
  { chain: 'ACCEPTED', plain: 'the panel agreed and the verdict is written' },
  { chain: 'FINALIZED', plain: 'the appeal window closes' },
];

const NODES = 5;

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Shorten a hash so it fits a hairline footer without wrapping. */
function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

export interface ConsensusProgressProps {
  /** What this round is deciding. One short phrase, sentence case. */
  job: string;
  /** Shown once the chain has given us a hash. Never guessed. */
  txHash?: string | null;
  /** Panel round, when the case is on its second reading. */
  round?: number | null;
  /** Set when consensus outlasted the request and the page stopped waiting. */
  outlasted?: boolean;
}

export function ConsensusProgress({
  job,
  txHash = null,
  round = null,
  outlasted = false,
}: ConsensusProgressProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section
      className="border border-line bg-raised"
      style={{ borderRadius: 'var(--radius-hair)' }}
      aria-live="polite"
      aria-busy={!outlasted}
    >
      {/* ---- header: who is working, and for how long --------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <span className="mono inline-flex items-center gap-2 text-12 text-text-2">
          <span className="consensus-turn inline-flex text-signal-bright">
            <Mark size={14} />
          </span>
          GenLayer consensus
        </span>
        <span className="mono tnum text-12 text-text-3">
          {round !== null && round > 1 ? `round ${round} · ` : ''}
          {clock(elapsed)}
        </span>
      </div>

      <div className="px-5 py-5">
        <p className="text-14 text-text">{job}</p>

        {/* ---- the panel: a leader, the validators, the round crossing ----- */}
        <div className="mt-5">
          <div className="relative flex items-center gap-2" aria-hidden="true">
            {Array.from({ length: NODES }, (_, i) => (
              <span
                key={i}
                className={i === 0 ? 'consensus-node is-leader' : 'consensus-node'}
                style={{ ['--i' as string]: i }}
              />
            ))}
            <span className="consensus-tie" />
          </div>
          <p className="mono mt-2.5 text-12 text-text-3">
            one leader, and validators that do not take its word for anything
          </p>
        </div>

        {/* ---- what is actually going on --------------------------------- */}
        <p className="mt-5 max-w-[62ch] text-13 text-text-2">
          Every validator fetches the insurer&rsquo;s bulletin itself, re-audits the codes in a
          sandbox and decides the case again on its own. Then they compare. The decision, the
          ground, the clause and the payout band all have to match, and the quote and the
          reasoning the leader wrote have to be carried by the document each validator just
          pulled down. Nothing reaches the chain unless that holds.
        </p>

        {/* ---- the route to finality -------------------------------------- */}
        <ol className="mt-5 flex flex-col gap-1.5">
          {STAGES.map((stage) => (
            <li key={stage.chain} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <span className="mono text-12 text-signal-bright">{stage.chain}</span>
              <span className="text-13 text-text-3">{stage.plain}</span>
            </li>
          ))}
        </ol>
        <p className="mono mt-2.5 text-12 text-text-3">the route every write takes, not a live reading</p>

        {outlasted && (
          <p className="mt-5 text-13 text-wait">
            The panel is still sitting and this page stopped waiting, which is not a failure.
            The verdict lands on the case page as soon as the validators agree.
          </p>
        )}
      </div>

      {/* ---- footer: the only hard facts we have ------------------------- */}
      <div className="mono flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-5 py-2.5 text-12 text-text-3">
        <span>studionet</span>
        <span aria-hidden="true">·</span>
        <span className="tnum">chain 61999</span>
        {txHash !== null && txHash !== '' && (
          <>
            <span aria-hidden="true">·</span>
            <span className="tnum" title={txHash}>
              {shortHash(txHash)}
            </span>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The inline version, for a button that is mid flight.
 *
 * The mark turning, rather than a generic spinner, so even the smallest pending state
 * still reads as this product on this chain.
 */
export function ConsensusPip({ size = 16 }: { size?: number }) {
  return (
    <span className="consensus-turn inline-flex" aria-hidden="true">
      <Mark size={size} />
    </span>
  );
}

export default ConsensusProgress;
