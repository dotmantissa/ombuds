import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { ombudsCourtAddress, readContract } from '@/lib/genlayer';
import { bandLabel } from '@/lib/bands';
import { GROUND_LABELS, isGround } from '@/types/ombuds';

export const dynamic = 'force-dynamic';

const DOCKET = /^OMB-\d{4}-\d{6}$/;

interface StateRow {
  state: string;
  state_name: string;
  agency: string;
  statute_citation: string;
  external_review_deadline_days: number;
  mechanism: string;
  statute_url: string;
  agency_url: string;
}

/**
 * The appeal letter.
 *
 * This is the artifact a member actually sends. It carries the docket number, the clause
 * the verdict rests on quoted verbatim, every source URL a reviewer can check, the
 * verdict digest so the on-chain record can be matched to the paper, and the external
 * review deadline for the member's own state.
 *
 * It is written in the member's voice, not in ours, because it goes out over their name.
 */
export async function GET(_req: Request, context: { params: Promise<{ docket: string }> }) {
  const { docket } = await context.params;
  if (!DOCKET.test(docket)) {
    return Response.json({ error: 'That does not look like a docket number.' }, { status: 400 });
  }

  const court = ombudsCourtAddress();

  let kase: Record<string, string | boolean | string[]>;
  let verdict: Record<string, unknown>;
  try {
    kase = await readContract({ address: court, functionName: 'get_case', args: [docket] });
    verdict = await readContract({ address: court, functionName: 'get_verdict', args: [docket] });
  } catch {
    return Response.json(
      { error: `There is no verdict on ${docket} yet, so there is nothing to put in a letter.` },
      { status: 404 },
    );
  }

  const stateCode = String(kase.state ?? '');
  const stateRow = await lookupState(stateCode);

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Appeal of a denied claim, docket ${docket}`);
  pdf.setSubject('Request for reconsideration and external review');
  pdf.setCreator('Ombuds');

  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);

  let page = pdf.addPage([595.28, 841.89]); // A4
  const margin = 56;
  const width = 595.28 - margin * 2;
  let y = 841.89 - margin;

  const ink = rgb(0.106, 0.098, 0.122);
  const grey = rgb(0.37, 0.33, 0.41);
  const brand = rgb(0.541, 0.118, 0.902);

  function space(n: number) {
    y -= n;
    if (y < margin + 60) {
      page = pdf.addPage([595.28, 841.89]);
      y = 841.89 - margin;
    }
  }

  function write(
    text: string,
    opts: { font?: typeof body; size?: number; colour?: typeof ink; gap?: number } = {},
  ) {
    const font = opts.font ?? body;
    const size = opts.size ?? 10.5;
    const colour = opts.colour ?? ink;
    for (const line of wrap(text, font, size, width)) {
      space(size + 3.5);
      page.drawText(line, { x: margin, y, size, font, color: colour });
    }
    if (opts.gap !== undefined) space(opts.gap);
  }

  function rule() {
    space(8);
    page.drawLine({
      start: { x: margin, y },
      end: { x: margin + width, y },
      thickness: 0.6,
      color: rgb(0.85, 0.83, 0.88),
    });
    space(6);
  }

  const overturn = verdict.overturn_recommended === true;
  const ground = String(verdict.ground ?? '');
  const groundLabel = isGround(ground) ? GROUND_LABELS[ground] : ground;
  const band = Number(verdict.recoverable_band ?? 0);

  write('REQUEST FOR RECONSIDERATION AND EXTERNAL REVIEW', { font: bold, size: 13 });
  space(2);
  write(`Ombuds docket ${docket}`, { font: mono, size: 9.5, colour: grey });
  rule();

  write('To whom it may concern,', { gap: 6 });

  write(
    `I am writing about a claim your plan denied. I do not think the denial is consistent ` +
      `with the coverage rule your own organisation published, and I would like it reconsidered. ` +
      `If you uphold it, please treat this as my request for external review.`,
    { gap: 8 },
  );

  write('The claim', { font: bold, size: 11, gap: 3 });
  write(`Plan rule on file: ${String(kase.plan_id ?? '')}`, { font: mono, size: 9.5 });
  write(`Procedure family: ${String(kase.family_id ?? '').replace(/_/g, ' ')}`, { font: mono, size: 9.5 });
  write(`Procedure codes billed: ${asList(kase.cpt_codes)}`, { font: mono, size: 9.5 });
  write(`Diagnosis codes: ${asList(kase.icd10_codes)}`, { font: mono, size: 9.5 });
  write(`Month of service: ${String(kase.service_month ?? '')}`, { font: mono, size: 9.5 });
  write(`Your stated denial reason code: ${String(kase.denial_reason_code ?? 'not stated')}`, {
    font: mono,
    size: 9.5,
    gap: 8,
  });

  write('What your own rule says', { font: bold, size: 11, gap: 3 });
  write(
    `Your clinical policy, at the section headed "${String(verdict.clause_section ?? '')}", says this:`,
    { gap: 4 },
  );
  write(`"${String(verdict.clause_quote ?? '')}"`, { size: 10, colour: brand, gap: 8 });

  write('Why I think the denial does not follow', { font: bold, size: 11, gap: 3 });
  write(String(verdict.reasoning ?? ''), { gap: 4 });
  write(`Ground of appeal: ${groundLabel}`, { font: mono, size: 9.5 });
  if (overturn) {
    write(`Amount I believe is recoverable: ${bandLabel(band)}`, { font: mono, size: 9.5 });
  }
  space(8);

  write('How this was assessed', { font: bold, size: 11, gap: 3 });
  write(
    `This assessment was produced by Ombuds, which reads a denial against the insurer's own ` +
      `published policy and the relevant federal coverage determination. The result was agreed ` +
      `independently by several validators on a public ledger, each of which re-fetched the ` +
      `documents below and had to arrive at the same decision, the same ground of appeal, the ` +
      `same cited clause and the same payout band before the result was recorded. The record is ` +
      `timestamped and cannot be edited after the fact.`,
    { gap: 4 },
  );
  write(`Verdict digest: ${String(verdict.digest ?? '')}`, { font: mono, size: 8.5, colour: grey });
  write(`Document hash of my denial letter: ${String(kase.evidence_sha256 ?? '')}`, {
    font: mono,
    size: 8.5,
    colour: grey,
    gap: 8,
  });

  write('Sources, which you are welcome to check', { font: bold, size: 11, gap: 3 });
  const citations = Array.isArray(verdict.citations) ? verdict.citations : [];
  for (const raw of citations) {
    const citation = raw as Record<string, string>;
    write(`${citation.source ?? ''}`, { size: 9.8 });
    if (citation.locator) write(`  at: ${citation.locator}`, { size: 9.2, colour: grey });
    write(`  ${citation.url ?? ''}`, { font: mono, size: 8.5, colour: grey });
    space(2);
  }
  space(6);

  if (stateRow !== null) {
    write('My external review rights', { font: bold, size: 11, gap: 3 });
    write(
      `I live in ${stateRow.state_name}. Under ${stateRow.statute_citation}, I may request ` +
        `${stateRow.mechanism} through the ${stateRow.agency} within ` +
        `${stateRow.external_review_deadline_days} days of your final internal denial. ` +
        `Please treat this letter as preserving that right.`,
      { gap: 3 },
    );
    write(`${stateRow.agency_url}`, { font: mono, size: 8.5, colour: grey, gap: 8 });
  }

  rule();
  write(
    `This letter concerns coverage and contract terms only. It is not medical advice and it ` +
      `makes no claim about what treatment is appropriate for anyone.`,
    { size: 9, colour: grey },
  );
  space(4);
  write('Yours sincerely,', { gap: 26 });
  write('_______________________________', { colour: grey });
  write('Signature and date', { size: 9, colour: grey });

  const bytes = await pdf.save();

  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="ombuds-appeal-${docket}.pdf"`,
    },
  });
}

function asList(value: unknown): string {
  if (Array.isArray(value) && value.length > 0) return value.map(String).join(', ');
  return 'none supplied';
}

/** Wrap text to a pixel width using the embedded font's own metrics. */
function wrap(
  text: string,
  font: { widthOfTextAtSize: (t: string, s: number) => number },
  size: number,
  max: number,
): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) > max && line !== '') {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines.length > 0 ? lines : [''];
}

async function lookupState(code: string): Promise<StateRow | null> {
  try {
    const file = path.join(process.cwd(), '..', 'data', 'sources.json');
    const data = JSON.parse(await readFile(file, 'utf8')) as { states: StateRow[] };
    return data.states.find((row) => row.state === code) ?? null;
  } catch {
    return null;
  }
}
