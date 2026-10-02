import { Mark } from './Mark';

interface LogoProps {
  size?: number;
  showWord?: boolean;
  className?: string;
}

/**
 * The lockup. Mark plus the word, set in the condensed display face so it reads like the
 * nameplate on a public office door rather than a product logo.
 */
export function Logo({ size = 22, showWord = true, className }: LogoProps) {
  return (
    <span
      className={`inline-flex items-center gap-[0.55em] text-signal ${className ?? ''}`}
      style={{ lineHeight: 1 }}
    >
      <Mark size={size} label={showWord ? undefined : 'Ombuds'} />
      {showWord && (
        <span
          className="font-[family-name:var(--font-display)] text-text"
          style={{
            fontSize: `${size * 0.95}px`,
            fontWeight: 700,
            fontStretch: '80%',
            letterSpacing: '-0.005em',
          }}
        >
          Ombuds
        </span>
      )}
    </span>
  );
}

export default Logo;
