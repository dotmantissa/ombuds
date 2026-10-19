/**
 * Payout band maths.
 *
 * A verdict never carries a continuous recoverable amount. It carries a band,
 * because a band is something several validators can independently agree on
 * and a dollar figure is not. Two validators reading the same bulletin will
 * land on the same band; they will not land on the same $4,217.33.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT CARRIES THE IDENTICAL BOUNDARIES.
 *
 * `contracts/ombuds_court.py` has the same six bands with the same cut points
 * in the same atto scale. If you change a boundary here you MUST change it
 * there in the same commit, and vice versa. A mismatch means the chain hands
 * back a band number that this file labels as something else, and the member
 * sees a figure the contract never agreed to. There is no runtime check that
 * will catch it for you.
 * ---------------------------------------------------------------------------
 *
 * Everything is BigInt. Not one float anywhere, because money.
 *
 * Atto scale means USD times 10 to the 18th, matching the smallest unit the
 * chain stores. One dollar is 1000000000000000000.
 */

/** One US dollar, in atto. */
export const ATTO_PER_USD = 10n ** 18n;

/** One US cent, in atto. */
export const ATTO_PER_CENT = 10n ** 16n;

/** Turn a whole number of dollars into atto. Used for the band boundaries. */
function usd(dollars: number): bigint {
  return BigInt(dollars) * ATTO_PER_USD;
}

export interface Band {
  /** The band number as the contract reports it. */
  band: number;
  /** Human readable, no hyphens. */
  label: string;
  /** Inclusive lower bound, in atto. */
  lower_atto: bigint;
  /** Exclusive upper bound in atto, or null for the open ended top band. */
  upper_atto: bigint | null;
}

/**
 * The six payout bands, ordered from smallest to largest.
 *
 * The cut points are 500, 2k, 7.5k, 25k and 75k US dollars. They are picked for
 * disputed medical claims: a few hundred dollars is a co-pay argument, the
 * middle bands are the ordinary imaging, specialist and outpatient range, and
 * the top band is surgery and inpatient.
 *
 * Lower bound inclusive, upper bound exclusive, so the bands tile the whole
 * non negative range with no gap and no overlap.
 */
export const BANDS: readonly Band[] = [
  {
    band: 0,
    label: 'Up to $500',
    lower_atto: 0n,
    upper_atto: usd(500),
  },
  {
    band: 1,
    label: '$500 to $2,000',
    lower_atto: usd(500),
    upper_atto: usd(2_000),
  },
  {
    band: 2,
    label: '$2,000 to $7,500',
    lower_atto: usd(2_000),
    upper_atto: usd(7_500),
  },
  {
    band: 3,
    label: '$7,500 to $25,000',
    lower_atto: usd(7_500),
    upper_atto: usd(25_000),
  },
  {
    band: 4,
    label: '$25,000 to $75,000',
    lower_atto: usd(25_000),
    upper_atto: usd(75_000),
  },
  {
    band: 5,
    label: '$75,000 and above',
    lower_atto: usd(75_000),
    upper_atto: null,
  },
] as const;

/** The lowest and highest band numbers, derived rather than hard coded. */
export const MIN_BAND = 0;
export const MAX_BAND = BANDS.length - 1;

/**
 * Which band a disputed amount falls into.
 *
 * Lower bound inclusive, upper bound exclusive. Exactly $500 is band 1, not
 * band 0, and the contract agrees.
 */
export function bandFor(attoAmount: bigint): number {
  if (attoAmount < 0n) {
    throw new RangeError('a disputed amount cannot be negative');
  }
  for (const entry of BANDS) {
    if (entry.upper_atto === null || attoAmount < entry.upper_atto) {
      return entry.band;
    }
  }
  // Unreachable while the top band stays open ended, but a fallback beats a
  // thrown error in a page that is only trying to render a chip.
  return BANDS[BANDS.length - 1]?.band ?? MIN_BAND;
}

/** The full band record for an amount. */
export function bandRecordFor(attoAmount: bigint): Band {
  const number = bandFor(attoAmount);
  const found = BANDS.find((entry) => entry.band === number);
  if (!found) {
    throw new RangeError(`band ${number} is not in the band table`);
  }
  return found;
}

/**
 * The human readable label for a band number.
 *
 * Tolerant on purpose. Band numbers arrive from the chain, and a page that is
 * only trying to draw a status chip should not blow up because the contract
 * grew a seventh band before this file did.
 */
export function bandLabel(band: number): string {
  const found = BANDS.find((entry) => entry.band === band);
  return found ? found.label : `Band ${band}`;
}

/** True when a number is a band this file knows about. */
export function isKnownBand(band: number): boolean {
  return BANDS.some((entry) => entry.band === band);
}

/* ---------------------------------------------------------------------------
   Formatting and parsing
   --------------------------------------------------------------------------- */

/** Insert thousands separators into a string of digits. */
function groupThousands(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && fromEnd % 3 === 1) out += ',';
  }
  return out;
}

/**
 * Render an atto amount as a dollar string, for example `$1,234.56`.
 *
 * Rounds to the nearest cent, halves away from zero. Integer maths throughout,
 * so there is no float to drift.
 */
export function formatAtto(atto: bigint): string {
  const negative = atto < 0n;
  const magnitude = negative ? -atto : atto;

  const cents = (magnitude + ATTO_PER_CENT / 2n) / ATTO_PER_CENT;
  const whole = cents / 100n;
  const remainder = cents % 100n;

  const dollars = groupThousands(whole.toString());
  const pennies = remainder.toString().padStart(2, '0');

  return `${negative ? '-' : ''}$${dollars}.${pennies}`;
}

/**
 * Render an atto amount with no cents, for example `$1,235`. For headline
 * figures where two decimal places are just noise.
 */
export function formatAttoRounded(atto: bigint): string {
  const negative = atto < 0n;
  const magnitude = negative ? -atto : atto;
  const dollars = (magnitude + ATTO_PER_USD / 2n) / ATTO_PER_USD;
  return `${negative ? '-' : ''}$${groupThousands(dollars.toString())}`;
}

const USD_PATTERN =
  /^(-)?\s*\$?\s*(?:([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+))?(?:\.([0-9]{1,18}))?$/;

/**
 * Read a user typed dollar amount into atto.
 *
 * Accepts a leading `$`, thousands separators, a leading minus and up to
 * eighteen decimal places. Rejects anything else rather than quietly guessing,
 * because this number decides what the pool pays out.
 *
 * `parseUsdToAtto('$1,234.56')` is `1234560000000000000000n`.
 */
export function parseUsdToAtto(input: string): bigint {
  const trimmed = input.trim();
  const match = USD_PATTERN.exec(trimmed);

  if (!match) {
    throw new RangeError('Enter a valid US dollar amount.');
  }

  const wholePart = (match[2] ?? '').replace(/,/g, '');
  const fractionPart = match[3] ?? '';

  if (wholePart.length === 0 && fractionPart.length === 0) {
    throw new RangeError('Enter a valid US dollar amount.');
  }

  const whole = wholePart.length > 0 ? BigInt(wholePart) : 0n;
  const fraction = BigInt(fractionPart.padEnd(18, '0'));
  const total = whole * ATTO_PER_USD + fraction;

  return match[1] ? -total : total;
}

/** Convenience for the common case of a whole dollar figure. */
export function usdToAtto(dollars: number): bigint {
  if (!Number.isInteger(dollars)) {
    throw new RangeError(
      'usdToAtto takes whole dollars only. Use parseUsdToAtto for cents.',
    );
  }
  return usd(dollars);
}
