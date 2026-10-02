/**
 * Tidying text we did not write.
 *
 * Two kinds of text reach a reader without passing through an author: the model's own
 * reasoning, and sentences quoted verbatim out of an insurer's bulletin. Both arrive with
 * punctuation we would never type, and the quoted ones arrive with maths symbols that a
 * standard PDF font cannot encode at all.
 *
 * So there are two passes here. `tidyProse` is cosmetic and runs on screen. `toWinAnsi`
 * is a correctness fix and runs before anything is drawn into a PDF, because pdf-lib
 * throws rather than substituting when it meets a character the font does not have.
 *
 * Neither pass touches anything consensus depends on. The clause quote is verified against
 * the source document inside the contract, before it is ever stored, and these functions
 * only change how the stored string is displayed.
 */

/** Punctuation swaps. Keeps meaning, drops the typography we do not use. */
const COSMETIC: ReadonlyArray<readonly [RegExp, string]> = [
  // A dash used as a clause break becomes a comma, which is what it was standing in for.
  [/\s+[—―]\s+/g, ', '],
  [/\s+–\s+/g, ', '],
  // A dash with no spaces around it is usually a range or a compound, so a hyphen is right.
  [/[—―–]/g, '-'],
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/…/g, '...'],
  [/ /g, ' '],
];

/** Symbols a standard PDF font has no glyph for, written out in words. */
const SPELLED: ReadonlyArray<readonly [RegExp, string]> = [
  [/≥/g, 'at least '],
  [/≤/g, 'at most '],
  [/≠/g, 'not equal to '],
  [/±/g, 'plus or minus '],
  [/×/g, 'x'],
  [/÷/g, '/'],
  [/−/g, '-'],
  [/²/g, '2'],
  [/³/g, '3'],
  [/•/g, '- '],
  [/·/g, '.'],
  [/[‐‑]/g, '-'],
  [/™/g, '(TM)'],
  [/®/g, '(R)'],
  [/©/g, '(C)'],
  [/′/g, "'"],
  [/″/g, '"'],
  [/½/g, '1/2'],
  [/¼/g, '1/4'],
  [/¾/g, '3/4'],
];

/** Readable on screen. Used for any string we did not write ourselves. */
export function tidyProse(input: string): string {
  let out = input;
  for (const [pattern, replacement] of COSMETIC) out = out.replace(pattern, replacement);
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Safe to draw with a standard PDF font.
 *
 * pdf-lib throws on any character WinAnsi cannot encode, so this has to be total: known
 * symbols are spelled out, and anything still outside the encodable range is dropped
 * rather than allowed to break the whole document.
 */
export function toWinAnsi(input: string): string {
  let out = tidyProse(input);
  for (const [pattern, replacement] of SPELLED) out = out.replace(pattern, replacement);
  // WinAnsi covers most of Latin-1 plus a handful of extras. Anything above that, and the
  // Latin-1 control gap at 0x80 to 0x9F, cannot be drawn.
  out = out.replace(/[^ -~ -ÿ]/g, '');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}
