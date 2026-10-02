/**
 * The Ombuds mark.
 *
 * A seal ring, open at the lower left, admitting a single rule that crosses the seal,
 * turns a half turn about the seal's own centre line and comes back out. That is the
 * product in one gesture: the insurer's own published rule, turned back on itself.
 *
 * Monoline, currentColor driven, no fills and no gradients, so it inherits the theme and
 * survives being printed on an appeal letter in one flat colour.
 */

interface MarkProps {
  size?: number | string;
  /** Pass a label to announce the mark. Leave it off and the mark is decorative. */
  label?: string;
  className?: string;
}

export function Mark({ size = 24, label, className }: MarkProps) {
  const decorative = label === undefined;

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      className={className}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : label}
    >
      {!decorative && <title>{label}</title>}
      <g stroke="currentColor" strokeLinecap="butt" strokeLinejoin="round">
        <path
          d="M3.654 16.325A9.4 9.4 0 1 0 2.662 13.075"
          strokeWidth={2.1}
          vectorEffect="non-scaling-stroke"
        />
        <path
          d="M1.905 14.7H14.3a2.7 2.7 0 0 0 0-5.4H5.8"
          strokeWidth={1.85}
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  );
}

export default Mark;
