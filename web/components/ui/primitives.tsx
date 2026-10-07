import type { CSSProperties, ReactNode } from 'react';

/**
 * The shared furniture.
 *
 * Flat panels, hairline rules, 2px corners, no shadows anywhere. Depth comes from the
 * ground shifting and from rules that run edge to edge, the way a ledger page works.
 */

export function Panel({
  children,
  className,
  style,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  /** Merged over the panel's own geometry. Used for the load sequence stagger index. */
  style?: CSSProperties;
  as?: 'div' | 'section' | 'article' | 'aside' | 'li';
}) {
  return (
    <Tag
      className={`border border-line bg-surface ${className ?? ''}`}
      style={{ borderRadius: 'var(--radius-hair)', ...style }}
    >
      {children}
    </Tag>
  );
}

/** A small mono label with a leading rule mark. Not an all caps tracked eyebrow. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={`mono inline-flex items-center gap-2 text-12 text-text-3 ${className ?? ''}`}>
      <span aria-hidden="true" className="inline-block h-px w-4 bg-line-strong" />
      {children}
    </span>
  );
}

export function Stat({
  value,
  caption,
  tone = 'default',
}: {
  value: ReactNode;
  caption: string;
  tone?: 'default' | 'signal' | 'win' | 'loss' | 'wait';
}) {
  const colour =
    tone === 'signal'
      ? 'var(--signal-bright)'
      : tone === 'win'
        ? 'var(--win)'
        : tone === 'loss'
          ? 'var(--loss)'
          : tone === 'wait'
            ? 'var(--wait)'
            : 'var(--text)';

  return (
    <div>
      <p className="mono tnum text-25 leading-none" style={{ color: colour }}>
        {value}
      </p>
      <p className="mt-1.5 text-13 text-text-2">{caption}</p>
    </div>
  );
}

const CHIP_TONE: Record<string, { fg: string; bd: string }> = {
  VERDICT: { fg: 'var(--win)', bd: 'var(--win)' },
  ADVANCED: { fg: 'var(--signal-bright)', bd: 'var(--signal)' },
  SETTLED: { fg: 'var(--text-2)', bd: 'var(--line-strong)' },
  FILED: { fg: 'var(--wait)', bd: 'var(--wait)' },
  ADJUDICATING: { fg: 'var(--wait)', bd: 'var(--wait)' },
  UNDER_REVIEW: { fg: 'var(--wait)', bd: 'var(--wait)' },
  REVIEWED: { fg: 'var(--wait)', bd: 'var(--wait)' },
  REJECTED: { fg: 'var(--loss)', bd: 'var(--loss)' },
};

export function StatusChip({ status, label }: { status: string; label?: string }) {
  const tone = CHIP_TONE[status] ?? { fg: 'var(--text-2)', bd: 'var(--line-strong)' };
  return (
    <span
      className="mono inline-flex items-center px-2 py-0.5 text-12"
      style={{
        borderRadius: 'var(--radius-pill)',
        border: `1px solid ${tone.bd}`,
        color: tone.fg,
      }}
    >
      {label ?? status.toLowerCase().replace(/_/g, ' ')}
    </span>
  );
}

/** A medical code. Monospaced, boxed, meant to be read character by character. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <span
      className="mono inline-block border border-line bg-raised px-1.5 py-0.5 text-12 text-text"
      style={{ borderRadius: 'var(--radius-hair)' }}
    >
      {children}
    </span>
  );
}

/**
 * The margin rail note.
 *
 * The structural device of the whole site. A claim in the main column ties by a hairline
 * into the margin, where the source it rests on sits. On a narrow screen the rail folds
 * underneath the claim it belongs to and the tie line disappears.
 */
export function RailNote({
  index,
  title,
  children,
}: {
  index?: number;
  title: string;
  children?: ReactNode;
}) {
  return (
    <aside className="rail-tie relative pl-0">
      <p className="mono text-12 text-text-3">
        {index !== undefined && <span className="tnum text-signal-bright">{`[${index}] `}</span>}
        {title}
      </p>
      {children !== undefined && <div className="mt-1 text-13 text-text-2">{children}</div>}
    </aside>
  );
}

export function FullRule({ strong = false }: { strong?: boolean }) {
  return <div aria-hidden="true" className={strong ? 'rule-full-strong' : 'rule-full'} />;
}
