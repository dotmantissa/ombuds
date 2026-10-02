'use client';

import { Mark } from './Mark';

type SealState = 'overturn' | 'upheld' | 'pending';

interface SealProps {
  docket: string;
  state: SealState;
  size?: number;
  className?: string;
}

const RING: Record<SealState, string> = {
  overturn: 'var(--win)',
  upheld: 'var(--loss)',
  pending: 'var(--wait)',
};

const CAPTION: Record<SealState, string> = {
  overturn: 'Overturn recommended',
  upheld: 'Denial upheld',
  pending: 'Awaiting a panel',
};

/**
 * The verdict seal. The one bit of ceremony in the whole product, used once per case page.
 *
 * It animates once on mount and then sits still, and it respects reduced motion because a
 * person reading a verdict about their own medical bill does not need movement.
 */
export function Seal({ docket, state, size = 132, className }: SealProps) {
  const ring = RING[state];

  return (
    <figure
      className={`stamp-in flex flex-col items-center gap-3 ${className ?? ''}`}
      style={{ margin: 0 }}
    >
      <div
        className="relative grid place-items-center rounded-full"
        style={{
          width: size,
          height: size,
          border: `1px solid ${ring}`,
          boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${ring} 22%, transparent)`,
        }}
      >
        <div
          className="absolute rounded-full"
          style={{
            inset: 7,
            border: `1px dashed color-mix(in oklab, ${ring} 45%, transparent)`,
          }}
          aria-hidden="true"
        />
        <span style={{ color: ring }}>
          <Mark size={Math.round(size * 0.34)} />
        </span>
      </div>
      <figcaption className="flex flex-col items-center gap-1">
        <span className="mono text-12 tnum text-text-3">{docket}</span>
        <span className="mono text-12 uppercase" style={{ color: ring, letterSpacing: '0.04em' }}>
          {CAPTION[state]}
        </span>
      </figcaption>
    </figure>
  );
}

export default Seal;
