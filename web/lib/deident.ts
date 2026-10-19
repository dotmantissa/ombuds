/**
 * The de-identification layer.
 *
 * Prompts are public on GenLayer. Every validator sees the case record, and so
 * does anyone reading the chain. So the thing that goes on chain has to contain
 * no patient. This module is where that is enforced.
 *
 * Pure functions only. No I/O, no environment, no network, no logging. Safe to
 * run in the browser, which is where it is meant to run: the member's own
 * machine strips the letter down before anything leaves it.
 *
 * Two notes on the shape of the code below.
 *
 * Person names are out of scope for regex. You cannot tell "Mr Baker" from "a
 * baker" with a pattern, so names are handled by the filing wizard asking the
 * member to confirm the rationale sentence, not by anything in here.
 *
 * Over redaction is the safe failure mode and under redaction is not, so the
 * patterns lean towards catching too much. The single exception is CPT and ICD
 * codes, which carry the whole clinical argument and must survive intact. Every
 * redaction runs through `isCodeLike` first and a valid code is left alone.
 */

import type { CaseRecord } from '../types/ombuds';
import { parseUsdToAtto } from './bands';

/* ---------------------------------------------------------------------------
   Kinds
   --------------------------------------------------------------------------- */

/** The identifier classes this module can find and remove. */
export type RedactionKind =
  | 'NAME'
  | 'MEMBER_ID'
  | 'MRN'
  | 'POLICY_NUMBER'
  | 'GROUP_NUMBER'
  | 'CLAIM_NUMBER'
  | 'ACCOUNT_NUMBER'
  | 'DATE_OF_BIRTH'
  | 'SSN'
  | 'EMAIL'
  | 'PHONE'
  | 'DATE'
  | 'STREET_ADDRESS'
  | 'ZIP'
  | 'URL_WITH_ID'
  | 'IP_ADDRESS';

export interface SafeHarborPattern {
  kind: RedactionKind;
  /** Why the pattern is shaped the way it is. Read this before editing one. */
  note: string;
  pattern: RegExp;
  /**
   * When true, group 1 is a label that stays and group 2 is the value that
   * goes, so `Member ID: 12345678` becomes `Member ID: [REDACTED:MEMBER_ID]`
   * and the reader can still tell what was taken out.
   */
  keepsLabel: boolean;
  /**
   * Whether a hit that looks like a CPT or ICD code is left alone. Defaults to
   * true, which is what protects the clinical codes.
   *
   * The ZIP patterns set this to false. A five digit ZIP and a five digit CPT
   * code are the same string, so the only thing that tells them apart is the
   * context, and those patterns already require a state code or an explicit
   * ZIP label before they fire. Once that context is there it beats the shape.
   */
  respectsCodes?: boolean;
}

/** The replacement token for a given kind. Stable, so diffs stay readable. */
export function redactionToken(kind: RedactionKind): string {
  return `[REDACTED:${kind}]`;
}

/* ---------------------------------------------------------------------------
   Shared fragments
   --------------------------------------------------------------------------- */

/**
 * The shape of an identifier value: at least four characters, letters digits
 * and dashes only, and it has to contain at least one digit. The digit
 * requirement is what stops `Member ID: see enclosed` redacting the word
 * `enclosed`.
 */
const ID_VALUE = '((?=[A-Za-z0-9._/-]*\\d)[A-Za-z0-9][A-Za-z0-9._/-]{2,})';

/** An optional `number`, `no.`, `id` or `#` suffix after a label word. */
const NUM_SUFFIX = '(?:id|no\\.?|number|nbr|#)';

/** The punctuation between a label and its value. */
const LABEL_TAIL = '\\s*[:#]?\\s*';

/** US state, district and territory codes, for the ZIP context test. */
const STATE_CODES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|' +
  'MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|' +
  'WV|WI|WY|AS|GU|MP|PR|VI';

/** Month names, long and abbreviated, for the written date patterns. */
const MONTHS =
  'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|' +
  'Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';

/**
 * Query parameter names that carry an identifier. Anchored so the name has to
 * be the whole parameter, which is why `?ncdid=190.3` on the CMS endpoint is
 * left alone while `?member_id=...` is not.
 */
const ID_PARAMS =
  'id|uid|userid|user_id|user|member|memberid|member_id|subscriber|mrn|ssn|' +
  'patient|patientid|patient_id|claim|claimid|claim_id|token|key|auth|' +
  'session|sid|pid|email';

/* ---------------------------------------------------------------------------
   The patterns
   --------------------------------------------------------------------------- */

/**
 * The HIPAA Safe Harbor identifiers that realistically turn up in a denial
 * letter, in the order they are applied.
 *
 * Order is deliberate. The label anchored identifiers run first so their
 * values are tokenised before a generic date or phone pattern can nibble a
 * digit off the end of one.
 */
export const SAFE_HARBOR_PATTERNS: readonly SafeHarborPattern[] = [
  {
    kind: 'NAME', note: 'Explicit patient, insured and provider name labels override code-shaped tokens.',
    pattern: /((?:patient|member|insured|subscriber|provider)\s+name\s*[:=]\s*)([^\n\r;<>]{2,100})/gi,
    keepsLabel: true, respectsCodes: false,
  },
  {
    kind: 'PHONE', note: 'Labelled phone and fax numbers, including international formats.',
    pattern: /((?:telephone|phone|mobile|fax|tel)\s*[:=]\s*)(\+?[\d() .-]{7,25}\d)/gi,
    keepsLabel: true, respectsCodes: false,
  },
  /* --- label anchored identifiers, first --- */
  {
    kind: 'MEMBER_ID',
    note:
      'Label anchored on purpose. A bare alphanumeric token is indistinguishable ' +
      'from an ICD-10 code, so the label is the only safe signal. The number ' +
      'suffix is optional because letters say "for member W12345678" as often ' +
      'as they say "Member ID:", and what keeps that safe is the digit ' +
      'requirement in ID_VALUE plus the isCodeLike check.',
    pattern: new RegExp(
      `((?:member|subscriber|enrollee|insured|beneficiary|patient)\\s*(?:${NUM_SUFFIX})?${LABEL_TAIL})${ID_VALUE}`,
      'gi',
    ),
    keepsLabel: true,
    respectsCodes: false,
  },
  {
    kind: 'MRN',
    note: 'Medical record number, spelled out or as the MRN acronym.',
    pattern: new RegExp(
      `((?:mrn|medical\\s+record(?:\\s+${NUM_SUFFIX})?)${LABEL_TAIL})${ID_VALUE}`,
      'gi',
    ),
    keepsLabel: true,
    respectsCodes: false,
  },
  {
    kind: 'POLICY_NUMBER',
    note: 'Policy, certificate and contract numbers all identify the person.',
    pattern: new RegExp(
      `((?:policy|certificate|cert\\.?|contract)\\s*${NUM_SUFFIX}${LABEL_TAIL})${ID_VALUE}`,
      'gi',
    ),
    keepsLabel: true,
    respectsCodes: false,
  },
  {
    kind: 'GROUP_NUMBER',
    note: 'An employer group number narrows a person down very fast.',
    pattern: new RegExp(
      `((?:group|grp\\.?)\\s*${NUM_SUFFIX}${LABEL_TAIL})${ID_VALUE}`,
      'gi',
    ),
    keepsLabel: true,
    respectsCodes: false,
  },
  {
    kind: 'CLAIM_NUMBER',
    note:
      'Claim number, internal control number and document control number. The ' +
      'suffix is optional because ICN and DCN appear bare, so isCodeLike is ' +
      'what keeps a CPT code from being eaten here.',
    pattern: new RegExp(
      `((?:claim|icn|dcn)\\s*(?:${NUM_SUFFIX})?${LABEL_TAIL})${ID_VALUE}`,
      'gi',
    ),
    keepsLabel: true,
    respectsCodes: false,
  },
  {
    kind: 'ACCOUNT_NUMBER',
    note: 'Patient account numbers on the billing side of a denial.',
    pattern: new RegExp(
      `((?:account|acct\\.?)\\s*(?:${NUM_SUFFIX})?${LABEL_TAIL})${ID_VALUE}`,
      'gi',
    ),
    keepsLabel: true,
    respectsCodes: false,
  },
  {
    kind: 'DATE_OF_BIRTH',
    note:
      'Its own kind rather than a plain date, because a date of birth is the ' +
      'single most re-identifying field in the whole letter.',
    pattern: new RegExp(
      `((?:date\\s+of\\s+birth|d\\.?o\\.?b\\.?|birth\\s*date)${LABEL_TAIL})` +
        `(\\d{1,2}[/\\-.]\\d{1,2}[/\\-.]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|` +
        `(?:${MONTHS})\\.?\\s+\\d{1,2},?\\s+\\d{4})`,
      'gi',
    ),
    keepsLabel: true,
    respectsCodes: false,
  },
  {
    kind: 'SSN',
    note: 'Labelled form, which allows the nine digit run with no separators.',
    pattern: new RegExp(
      `((?:ssn|social\\s+security(?:\\s+${NUM_SUFFIX})?)${LABEL_TAIL})` +
        `(\\d{3}-?\\d{2}-?\\d{4}|\\d{9})`,
      'gi',
    ),
    keepsLabel: true,
    respectsCodes: false,
  },

  /* --- unambiguous shapes, no label needed --- */
  {
    kind: 'SSN',
    note: 'The formatted three two four run. Nothing else looks like this.',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    keepsLabel: false,
  },
  {
    kind: 'EMAIL',
    note: 'An email address is a Safe Harbor identifier in its own right.',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    keepsLabel: false,
  },
  {
    kind: 'URL_WITH_ID',
    note:
      'A URL whose query string carries an identifier. The parameter name has ' +
      'to match in full, which is what leaves the CMS ncdid endpoint intact.',
    pattern: new RegExp(
      `https?://[^\\s<>"']*[?&](?:${ID_PARAMS})=[^\\s<>"'&]+[^\\s<>"']*`,
      'gi',
    ),
    keepsLabel: false,
  },
  {
    kind: 'URL_WITH_ID',
    note:
      'A URL with a long opaque path segment, a uuid or 24 plus hex characters. ' +
      'Short numeric path segments are left alone, so the Aetna bulletin paths ' +
      'survive.',
    pattern:
      /https?:\/\/[^\s<>"']*\/(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{24,})[^\s<>"']*/g,
    keepsLabel: false,
  },
  {
    kind: 'IP_ADDRESS',
    note: 'Four octets. A bare dotted pair like 190.3 does not match.',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    keepsLabel: false,
  },
  {
    kind: 'PHONE',
    note:
      'Separators are required. A bare ten digit run is not matched, because ' +
      'that is how a list of CPT codes would get shredded. The word boundary ' +
      'sits on the bare digit branch only. Putting it at the front would kill ' +
      '"(415) 555-0123", because there is no boundary between a space and an ' +
      'opening bracket.',
    pattern:
      /(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?\s*|\b\d{3}[\s.-]\s*)\d{3}[\s.-]\d{4}\b/g,
    keepsLabel: false,
  },
  {
    kind: 'PHONE',
    note: 'Labelled phone or fax, which allows an unseparated run of digits.',
    pattern: new RegExp(
      `((?:phone|telephone|tel\\.?|fax|facsimile|mobile|cell)\\s*(?:${NUM_SUFFIX})?${LABEL_TAIL})` +
        `(\\+?[\\d\\s().-]{6,}\\d)`,
      'gi',
    ),
    keepsLabel: true,
  },

  /* --- dates --- */
  {
    kind: 'DATE',
    note:
      'A full numeric date, two separators required. A service month in the ' +
      'YYYY-MM form has only one separator and is deliberately left alone, ' +
      'because that bucketed form is what we are allowed to keep.',
    pattern: /\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b/g,
    keepsLabel: false,
  },
  {
    kind: 'DATE',
    note: 'A full ISO date. Again three parts, so YYYY-MM is safe.',
    pattern: /\b\d{4}-\d{2}-\d{2}\b/g,
    keepsLabel: false,
  },
  {
    kind: 'DATE',
    note: 'A written date, month first.',
    pattern: new RegExp(
      `\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`,
      'g',
    ),
    keepsLabel: false,
  },
  {
    kind: 'DATE',
    note: 'A written date, day first.',
    pattern: new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}\\b`, 'g'),
    keepsLabel: false,
  },

  /* --- geography --- */
  {
    kind: 'STREET_ADDRESS',
    note:
      'Deliberately case sensitive and it requires at least one capitalised ' +
      'street name word between the number and the suffix. Without that, a ' +
      'phrase like "99214 Place of service" would redact a live CPT code.',
    pattern:
      /\b\d{1,6}\s+(?:[A-Z][A-Za-z.'-]*\.?\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Way|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy)\b\.?/g,
    keepsLabel: false,
  },
  {
    kind: 'STREET_ADDRESS',
    note:
      'Suite, apartment and unit designators. The value has to contain a digit ' +
      'and the keyword needs a word boundary, so "3 units of insulin" is left ' +
      'well alone.',
    pattern:
      /\b((?:Suite|Ste|Apartment|Apt|Unit|Room|Rm)\b\.?\s*#?\s*)((?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{1,8})\b/gi,
    keepsLabel: true,
  },
  {
    kind: 'STREET_ADDRESS',
    note: 'A post office box.',
    pattern: /\bP\.?\s?O\.?\s+Box\s+\d{1,8}\b/gi,
    keepsLabel: false,
  },
  {
    kind: 'ZIP',
    note: 'ZIP plus four. Unambiguous, nothing else is five dash four digits.',
    pattern: /\b\d{5}-\d{4}\b/g,
    keepsLabel: false,
    respectsCodes: false,
  },
  {
    kind: 'ZIP',
    note:
      'A five digit ZIP is only redacted when a real state code sits in front ' +
      'of it. A bare five digit number is left alone, because a ZIP and a CPT ' +
      'code are the same shape and the code has to survive.',
    pattern: new RegExp(`\\b(?:${STATE_CODES})\\s+\\d{5}(?:-\\d{4})?\\b`, 'g'),
    keepsLabel: false,
    respectsCodes: false,
  },
  {
    kind: 'ZIP',
    note: 'A labelled ZIP, where the label removes the ambiguity.',
    pattern: /\b((?:zip|postal)(?:\s*code)?\s*[:#]?\s*)(\d{5}(?:-\d{4})?)\b/gi,
    keepsLabel: true,
    respectsCodes: false,
  },
];

/* ---------------------------------------------------------------------------
   Code recognition
   --------------------------------------------------------------------------- */

/**
 * CPT Category I, five digits. Also matches a ZIP, which is exactly why this
 * is only ever used as a candidate list and why the ZIP patterns above need a
 * state code or a label before they will fire.
 */
const CPT_NUMERIC = /\b\d{5}\b/g;

/** CPT Category II and III, four digits then F, M, T or U. */
const CPT_SUFFIXED = /\b\d{4}[FMTU]\b/g;

/**
 * HCPCS Level II, a letter then four digits. The letter set is the real HCPCS
 * range, which drops D, F, I, N, O, U, W, X, Y and Z.
 *
 * This does overlap with an ICD-10 code written without its decimal point, for
 * example E6601 for E66.01. There is no way to tell them apart from the string
 * alone, so a dotless five character code lands in the CPT list. The filing
 * wizard shows both lists back to the member for confirmation.
 */
const HCPCS = /\b[A-CEGHJ-MPQRSTV]\d{4}\b/g;

/**
 * ICD-10-CM. A letter, two digits, then optionally a dot and up to four more
 * alphanumerics. U is excluded because it is reserved.
 *
 * The decimal point is required for the extended form. A dotless long form is
 * indistinguishable from HCPCS, so it is not matched here on purpose.
 */
const ICD10 = /\b[A-TV-Z]\d{2}(?:\.[0-9A-TV-Z]{1,4})?\b/g;

/** Anchored copies, for testing one exact string rather than scanning text. */
const EXACT_CPT = /^(?:\d{5}|\d{4}[FMTU]|[A-CEGHJ-MPQRSTV]\d{4})$/;
const EXACT_ICD10 = /^[A-TV-Z]\d{2}(?:\.[0-9A-TV-Z]{1,4})?$/;

/**
 * True when a string is a CPT, HCPCS or ICD-10 code.
 *
 * Every redaction consults this before it fires. Codes carry the entire
 * clinical argument, so a scrubber that eats one has broken the case it was
 * meant to protect.
 */
export function isCodeLike(value: string): boolean {
  const trimmed = value.trim().toUpperCase();
  return EXACT_CPT.test(trimmed) || EXACT_ICD10.test(trimmed);
}

/* ---------------------------------------------------------------------------
   Scrubbing
   --------------------------------------------------------------------------- */

export interface Redaction {
  kind: RedactionKind;
  count: number;
}

export interface ScrubResult {
  /** The text with every identifier swapped for a stable token. */
  clean: string;
  /** What was taken out and how much of it. Never the values themselves. */
  redactions: Redaction[];
}

/**
 * A fresh copy of a regex.
 *
 * Global regexes carry `lastIndex` between calls, and a shared one used with
 * `test` will silently start halfway through the next string. Cloning is
 * cheaper than the bug.
 */
function freshRegex(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

/** Normalize copied HTML, OCR typography and invisible separators before detection. */
export function normaliseDocumentText(input: string): string {
  return input.normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/&amp;/gi, '&')
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_m, hex, dec) => {
      const point = Number.parseInt(hex ?? dec, hex ? 16 : 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    })
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&ensp;|&emsp;/gi, ' ')
    .replace(/&commat;/gi, '@').replace(/&amp;/gi, '&');
}

/**
 * Remove every Safe Harbor identifier this module can recognise.
 *
 * Each hit becomes a stable token like `[REDACTED:PHONE]`, so the shape of the
 * sentence survives and a reader can see what was taken. Label anchored hits
 * keep their label, so `Member ID: 90210443` reads back as
 * `Member ID: [REDACTED:MEMBER_ID]`.
 *
 * CPT and ICD codes are never touched.
 */
export function scrubText(input: string): ScrubResult {
  let clean = normaliseDocumentText(input);
  const counts = new Map<RedactionKind, number>();

  const bump = (kind: RedactionKind): void => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  };

  for (const entry of SAFE_HARBOR_PATTERNS) {
    const pattern = freshRegex(entry.pattern);
    const token = redactionToken(entry.kind);
    const guardCodes = entry.respectsCodes !== false;

    clean = clean.replace(
      pattern,
      (match: string, ...rest: unknown[]): string => {
        if (entry.keepsLabel) {
          const label = typeof rest[0] === 'string' ? rest[0] : '';
          const value = typeof rest[1] === 'string' ? rest[1] : '';
          if (guardCodes && isCodeLike(value)) return match;
          bump(entry.kind);
          return `${label}${token}`;
        }
        if (guardCodes && isCodeLike(match)) return match;
        bump(entry.kind);
        return token;
      },
    );
  }

  // Ordered by the kind list so the summary is stable between runs.
  const redactions: Redaction[] = [];
  for (const entry of SAFE_HARBOR_PATTERNS) {
    if (redactions.some((r) => r.kind === entry.kind)) continue;
    const count = counts.get(entry.kind);
    if (count !== undefined && count > 0) {
      redactions.push({ kind: entry.kind, count });
    }
  }

  return { clean, redactions };
}

/* ---------------------------------------------------------------------------
   Dates
   --------------------------------------------------------------------------- */

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * Bucket a service date down to a month.
 *
 * Safe Harbor allows a year. A month is a little tighter than the rule needs
 * and it is still enough to decide which version of a plan rule applied, which
 * is the only reason the date is kept at all.
 *
 * Accepts `YYYY-MM-DD`, `YYYY-MM`, the US `M/D/YYYY` ordering, and anything
 * else the platform can parse. Returns `YYYY-MM` and nothing more.
 */
export function bucketServiceDate(iso: string): string {
  const trimmed = iso.trim();

  const isoLike = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?(?:[T\s].*)?$/.exec(trimmed);
  if (isoLike) {
    const year = Number(isoLike[1]);
    const month = Number(isoLike[2]);
    if (month >= 1 && month <= 12) return `${year}-${pad2(month)}`;
    throw new RangeError('The service month must be between 1 and 12.');
  }

  // US ordering, month first, because these are US denial letters.
  const usLike = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(trimmed);
  if (usLike) {
    const month = Number(usLike[1]);
    const rawYear = Number(usLike[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    if (month >= 1 && month <= 12) return `${year}-${pad2(month)}`;
    throw new RangeError('The service month must be between 1 and 12.');
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError('Enter a valid service date.');
  }
  // Local components, to match whatever the platform just parsed. Reading UTC
  // here would shift a midnight date into the previous month.
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}`;
}

/* ---------------------------------------------------------------------------
   Code extraction
   --------------------------------------------------------------------------- */

export interface ExtractedCodes {
  /** Candidate CPT and HCPCS codes, de-duplicated and sorted. */
  cpt: string[];
  /** Candidate ICD-10-CM codes, de-duplicated and sorted. */
  icd10: string[];
}

function collect(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  const re = freshRegex(pattern);
  let hit = re.exec(text);
  while (hit !== null) {
    found.push(hit[0].toUpperCase());
    hit = re.exec(text);
  }
  return found;
}

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Pull candidate CPT, HCPCS and ICD-10-CM codes out of a block of text.
 *
 * Candidate is the operative word. A five digit CPT code and a ZIP are the same
 * shape, and a dotless ICD code and a HCPCS code are the same shape, so this
 * returns everything that fits and the filing wizard asks the member to confirm.
 *
 * Run this on scrubbed text, not raw text. Scrubbing removes the ZIPs that sit
 * in an address, which takes most of the five digit noise out first.
 */
export function extractCodes(text: string): ExtractedCodes {
  const icd10 = dedupeSorted(collect(text, ICD10));

  const cptRaw = [
    ...collect(text, CPT_NUMERIC),
    ...collect(text, CPT_SUFFIXED),
    ...collect(text, HCPCS),
  ];

  // Anything already claimed as an ICD code does not also go in the CPT list.
  const icdSet = new Set(icd10);
  const cpt = dedupeSorted(cptRaw.filter((code) => !icdSet.has(code)));

  return { cpt, icd10 };
}

/* ---------------------------------------------------------------------------
   Hashing
   --------------------------------------------------------------------------- */

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Node's crypto module, or null when there is not one.
 *
 * The specifier is held in a variable and flagged for both bundlers on purpose.
 * This file runs in the browser, and a statically analysable `import
 * ('node:crypto')` would make the client build try to resolve a node builtin
 * and fall over.
 */
async function nodeCrypto(): Promise<typeof import('node:crypto') | null> {
  if (typeof window !== 'undefined') return null;
  try {
    const specifier = 'node:crypto';
    const loaded = (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ specifier
    )) as typeof import('node:crypto');
    return loaded;
  } catch {
    return null;
  }
}

/**
 * SHA-256, as lowercase hex.
 *
 * Node's crypto on the server, `crypto.subtle` in the browser, and subtle again
 * as the fallback on any runtime that has no node builtins. Async because
 * `crypto.subtle.digest` is, and there is no point having two shapes of the
 * same function.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input;

  const nodeSide = await nodeCrypto();
  if (nodeSide) {
    return nodeSide.createHash('sha256').update(bytes).digest('hex');
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'no SHA-256 implementation available: neither node crypto nor crypto.subtle',
    );
  }
  const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return toHex(new Uint8Array(digest));
}

/* ---------------------------------------------------------------------------
   The PHI guard
   --------------------------------------------------------------------------- */

/** Thrown when a record still matches a Safe Harbor pattern. */
export class PhiLeakError extends Error {
  readonly field: string;
  readonly kind: RedactionKind;

  constructor(field: string, kind: RedactionKind) {
    // The matched text is NOT in this message. The matched text is the PHI, and
    // an error message ends up in a log.
    super(
      `de-identification failed: field "${field}" still matches the ` +
        `${kind} pattern. Nothing has been sent. Fix the input and try again.`,
    );
    this.name = 'PhiLeakError';
    this.field = field;
    this.kind = kind;
  }
}

/** Every string inside a record, paired with the path it was found at. */
function stringFields(record: CaseRecord): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ['plan_id', record.plan_id],
    ['family_id', record.family_id],
    ['state', record.state],
    ['denial_reason_code', record.denial_reason_code],
    ['denial_rationale', record.denial_rationale],
    ['service_month', record.service_month],
    ['evidence_sha256', record.evidence_sha256],
  ];
  record.cpt_codes.forEach((value, index) => {
    out.push([`cpt_codes[${index}]`, value]);
  });
  record.icd10_codes.forEach((value, index) => {
    out.push([`icd10_codes[${index}]`, value]);
  });
  record.source_urls.forEach((value, index) => {
    out.push([`source_urls[${index}]`, value]);
  });
  return out;
}

/**
 * Throw if any Safe Harbor pattern still matches anywhere in the record.
 *
 * This is the last thing `buildCaseRecord` does, and it is the reason the
 * record can be handed to a public prompt without a second thought. A source
 * URL that carries an identifier is rejected here rather than quietly mangled,
 * because a half rewritten URL is a worse outcome than a loud refusal.
 */
export function assertNoPhi(record: CaseRecord): void {
  for (const [field, value] of stringFields(record)) {
    if (!value) continue;
    for (const entry of SAFE_HARBOR_PATTERNS) {
      const pattern = freshRegex(entry.pattern);
      let hit;
      while ((hit = pattern.exec(normaliseDocumentText(value))) !== null) {

      const detected = entry.keepsLabel ? (hit[2] ?? hit[0]) : hit[0];
      if (detected === redactionToken(entry.kind)) continue;

      // A bare code is not PHI. This is the same exemption scrubText applies,
      // and without it a record whose only content is codes would be rejected.
      // The exemption has to be skipped for the same patterns scrubText skips
      // it for, or the guard would wave through exactly what the scrubber took
      // the trouble to remove.
      if (entry.respectsCodes !== false) {
        const span = entry.keepsLabel ? (hit[2] ?? hit[0]) : hit[0];
        if (isCodeLike(span)) continue;
      }

      throw new PhiLeakError(field, entry.kind);
      }
    }
  }
}

/* ---------------------------------------------------------------------------
   Building the record
   --------------------------------------------------------------------------- */

export interface BuildCaseRecordInput {
  planId: string;
  familyId: string;
  /** Two letter state code. Case insensitive on the way in. */
  state: string;
  /**
   * The full denial letter text. Scrubbed, mined for codes, and then dropped.
   * It is never part of the returned record.
   */
  letterText: string;
  /** The verbatim denial rationale sentence the member picked out. */
  denialRationale: string;
  /** The insurer's own denial reason code. */
  denialReasonCode: string;
  /** A full service date. Bucketed to a month, and then dropped. */
  serviceDate: string;
  /** The disputed amount, as a typed dollar string or already in atto. */
  disputedAmount: string | bigint;
  /** Public source URLs a validator will re-fetch. */
  sourceUrls: string[];
  /** The original document. Hashed, and then dropped. */
  evidenceBytes?: Uint8Array | null;
  /** A SHA-256 hex digest, when the hashing has already happened elsewhere. */
  evidenceSha256?: string | null;
  /** Explicit code lists. When absent, codes are mined from the letter text. */
  cptCodes?: string[];
  icd10Codes?: string[];
}

/** One field that was deliberately left out, and why. */
export interface DroppedField {
  field: string;
  reason: string;
}

export interface BuildCaseRecordResult {
  /** The de-identified record. Safe to put in a public prompt. */
  record: CaseRecord;
  /** What was deliberately dropped on the way, and why. */
  dropped: DroppedField[];
  /** What was redacted out of the text that was kept. */
  redactions: Redaction[];
}

function mergeRedactions(groups: Redaction[][]): Redaction[] {
  const totals = new Map<RedactionKind, number>();
  for (const group of groups) {
    for (const item of group) {
      totals.set(item.kind, (totals.get(item.kind) ?? 0) + item.count);
    }
  }
  return [...totals.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Compose the de-identified case record.
 *
 * This is the whole PHI design in one function. What goes in is a denial letter
 * and some form fields. What comes out is codes, a reason code, one scrubbed
 * sentence, a plan id, a state, a month, an amount, a hash and some public
 * URLs. Everything else is dropped and the drop list says so by name.
 *
 * The final step is `assertNoPhi`. If that throws, nothing is returned, so a
 * record that still carries an identifier cannot be sent by accident.
 */
export async function buildCaseRecord(
  input: BuildCaseRecordInput,
): Promise<BuildCaseRecordResult> {
  /* --- the text we keep --- */
  const rationale = scrubText(input.denialRationale.trim());

  /* --- the text we mine and then throw away --- */
  const letter = scrubText(input.letterText);

  /* --- codes --- */
  const mined = extractCodes(letter.clean);
  const cptCodes = dedupeSorted(
    (input.cptCodes ?? mined.cpt).map((code) => code.trim().toUpperCase()),
  );
  const icd10Codes = dedupeSorted(
    (input.icd10Codes ?? mined.icd10).map((code) => code.trim().toUpperCase()),
  );

  if (cptCodes.length + icd10Codes.length > 40 ||
      cptCodes.some((c) => !/^(?:\d{5}|[A-Z]\d{4})$/.test(c)) ||
      icd10Codes.some((c) => !/^[A-TV-Z]\d{2}(?:\.[0-9A-Z]{1,4})?$/.test(c))) {
    throw new RangeError('Review the procedure and diagnosis codes.');
  }

  /* --- amount --- */
  const disputedAmountAtto =
    typeof input.disputedAmount === 'bigint'
      ? input.disputedAmount
      : parseUsdToAtto(input.disputedAmount);
  if (disputedAmountAtto < 0n) {
    throw new RangeError('a disputed amount cannot be negative');
  }

  /* --- evidence hash --- */
  let evidenceSha256: string;
  if (input.evidenceSha256) {
    const candidate = input.evidenceSha256.trim().toLowerCase();
    if (!HEX64.test(candidate)) {
      throw new RangeError('evidenceSha256 must be 64 lowercase hex characters');
    }
    evidenceSha256 = candidate;
  } else if (input.evidenceBytes) {
    evidenceSha256 = await sha256Hex(input.evidenceBytes);
  } else {
    throw new RangeError(
      'buildCaseRecord needs either evidenceBytes or evidenceSha256. ' +
        'The original document is what the hash commits to, so there has to be one.',
    );
  }

  /* --- state --- */
  const state = input.state.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    throw new RangeError('Use a two letter state code.');
  }

  /* --- source URLs --- */
  const sourceUrls = [
    ...new Set(input.sourceUrls.map((url) => url.trim()).filter(Boolean)),
  ];

  const record: CaseRecord = {
    plan_id: input.planId.trim(),
    family_id: input.familyId.trim(),
    state,
    cpt_codes: cptCodes,
    icd10_codes: icd10Codes,
    denial_reason_code: scrubText(input.denialReasonCode.trim()).clean,
    denial_rationale: rationale.clean,
    service_month: bucketServiceDate(input.serviceDate),
    disputed_amount_atto: disputedAmountAtto,
    evidence_sha256: evidenceSha256,
    source_urls: sourceUrls,
  };

  const dropped: DroppedField[] = [
    {
      field: 'letterText',
      reason:
        'The raw denial letter never goes on chain. It is read for codes and ' +
        'then discarded. Only its SHA-256 is committed.',
    },
    {
      field: 'evidenceBytes',
      reason:
        'The original document stays on the member machine. The hash is what ' +
        'proves it has not changed.',
    },
    {
      field: 'serviceDate',
      reason:
        'A full service date is a Safe Harbor identifier. Only the month survives, ' +
        'which is all that is needed to pick the plan rule that applied.',
    },
    {
      field: 'memberName',
      reason:
        'Never collected and never needed. The adjudication is about a contract ' +
        'clause, not about who the member is.',
    },
    {
      field: 'memberId',
      reason: 'Stripped by the scrubber and never stored.',
    },
    {
      field: 'dateOfBirth',
      reason: 'The single most re-identifying field in a denial letter.',
    },
    {
      field: 'providerName',
      reason:
        'Not collected. Network status is argued from the plan documents, not ' +
        'from naming the clinician.',
    },
    {
      field: 'email',
      reason:
        'The member email is held by Privy and stored here only as a SHA-256 ' +
        'hash. It never reaches a case record.',
    },
  ];

  // Last step, always. Nothing is returned until this passes.
  assertNoPhi(record);

  return {
    record,
    dropped,
    redactions: mergeRedactions([rationale.redactions, letter.redactions]),
  };
}
