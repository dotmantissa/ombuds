import Link from 'next/link';

import { Code, FullRule, Label, Panel, RailNote } from '@/components/ui/primitives';
import { courtConfig } from '@/lib/chainReads';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'How it works' };

const STAGES = [
  {
    title: 'You paste the letter',
    body: 'It goes through de-identification in the browser session. Procedure codes, diagnosis codes, the denial reason code and one scrubbed sentence of the insurer’s own rationale come out. Your name, member id, date of birth and the full date of service do not. The document is hashed and the hash is all that is committed.',
  },
  {
    title: 'The registry decides whether there is a case to answer',
    body: 'Every plan rule has an effective window. A rule that has lapsed cannot be argued against, and the filing is refused before a single validator cycle is spent. Arguing against last year’s policy is how an appeal gets thrown out, so the refusal happens early and loudly.',
  },
  {
    title: 'A panel does the whole job, several times over',
    body: 'Each validator fetches the insurer’s bulletin and the federal coverage determination at the same URLs, audits the codes by running code rather than by asking a model, and reaches its own answer. Then they compare.',
  },
  {
    title: 'The money moves on its own',
    body: 'If the verdict recommends overturning and clears the confidence band, the advance pool pays a share of the disputed amount to the member. No human approves it. The pool reads the court, and the court only says yes when the panel agreed.',
  },
  {
    title: 'You get a letter with the citations already in it',
    body: 'A PDF in your voice, carrying the clause quoted verbatim, every source URL, the verdict digest so the paper can be matched to the on-chain record, and your own state’s external review deadline.',
  },
];

export default async function HowItWorks() {
  const config = await courtConfig();

  return (
    <section className="mx-auto max-w-[1240px] px-4 pb-20 pt-12">
      <div className="seq set-type" style={{ ['--i' as string]: 0 }}>
        <Label>The mechanism, without the hand waving</Label>
        <h1 className="display mt-4 max-w-[34rem] text-49 text-text">
          What actually happens between your letter and a verdict.
        </h1>
      </div>

      <div className="mt-12 rail">
        <div className="rail-main">
          <ol className="flex flex-col">
            {STAGES.map((stage, index) => (
              <li
                key={stage.title}
                className="seq stamp-in border-b border-line py-7 first:pt-0 last:border-b-0"
                style={{ ['--i' as string]: index }}
              >
                <div className="flex items-baseline gap-4">
                  <span className="mono tnum shrink-0 text-13 text-signal-bright">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <h2 className="display text-25 text-text">{stage.title}</h2>
                    <p className="mt-2.5 max-w-[42rem] text-16 text-text-2">{stage.body}</p>
                  </div>
                </div>
              </li>
            ))}
          </ol>

          <h2 className="display mt-14 text-31 text-text">The comparison rule, in full</h2>
          <p className="mt-3 max-w-[42rem] text-16 text-text-2">
            This is the part that makes a verdict worth more than an opinion. A validator never reads
            the leader&apos;s reasoning and agrees with it. It redoes the work and compares results.
          </p>

          <div
            className="mt-6 border border-line"
            style={{ borderRadius: 'var(--radius-hair)' }}
          >
            {[
              ['overturn_recommended', 'must match exactly', 'There is no partial credit on whether a denial stands.'],
              ['ground', 'must match exactly, five values', 'A coding error and a medical necessity dispute lead to different letters and different statutes.'],
              ['clause_id', 'must match exactly', 'The anti hallucination clamp. Checkable because both sides just re-fetched the document.'],
              ['recoverable_band', 'same discrete band', 'Nobody agrees on a figure. Everybody can agree on a range.'],
              ['confidence', 'same side of the money line', `Not compared as a number. What matters is whether it clears ${config?.min_confidence ?? 70} of 100, because that is what releases an advance.`],
              ['code audit', 'must match exactly', 'Computed by running code, so any difference means the two nodes were not reading the same document.'],
            ].map(([field, rule, why], index) => (
              <div
                key={field}
                className={`p-5 ${index < 5 ? 'border-b border-line' : ''}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Code>{field}</Code>
                  <span className="mono text-12 text-signal-bright">{rule}</span>
                </div>
                <p className="mt-2 max-w-[44rem] text-14 text-text-2">{why}</p>
              </div>
            ))}
          </div>

          <Panel className="mt-6 p-6">
            <p className="text-16 text-text">What happens when they disagree</p>
            <p className="mt-2 max-w-[44rem] text-14 text-text-2">
              Divergence on any of those means the panel rotates and the case is read again. Nothing
              is written. There is one deliberate exception: if both sides independently hit the same
              transient failure, a source that is down for everybody, they agree that the source was
              down. A dead government API is not a disagreement, and treating it as one would make
              the whole thing unusable on a bad afternoon.
            </p>
          </Panel>

          <h2 className="display mt-14 text-31 text-text">What Ombuds will not do</h2>
          <ul className="mt-5 flex max-w-[44rem] flex-col gap-3 text-16 text-text-2">
            <li>
              It will not give medical advice. It argues about coverage and contract terms. Whether a
              treatment is right for you is a conversation with your doctor and nothing here replaces
              it.
            </li>
            <li>
              It will not pretend to be your lawyer. The letter it produces is yours, in your voice,
              and you decide whether to send it.
            </li>
            <li>
              It will not claim certainty it does not have. A verdict carries a confidence figure and
              an appeal path, and either side can send it back to a fresh panel.
            </li>
            <li>
              It will not quietly cover a scope it cannot handle. Version one covers five procedure
              families where the source coverage is genuinely deep, rather than fifty where it would
              be thin.
            </li>
          </ul>

          <Link
            href="/file"
            className="mono mt-10 inline-flex items-center gap-1.5 text-14 text-signal-bright hover:underline"
          >
            Start a case
          </Link>
        </div>

        <div className="rail-aside flex flex-col gap-6">
          <RailNote title="Why on a chain at all">
            Because the value is in the agreement, not the inference. A timestamped result that
            several independent parties reached from public sources is a different kind of object
            from one model&apos;s answer.
          </RailNote>
          <RailNote title="Why bands and not figures">
            Stable consensus on money needs a discrete answer. Bands are the only way several
            independent readers land on the same thing.
          </RailNote>
          <RailNote title="Why the codes are not asked of a model">
            Models drop leading zeros and invent modifiers. Code formats are checked by code, and
            the result is handed to the model as ground truth it is told not to override.
          </RailNote>
          <RailNote title="Why prompts being public is fine">
            Because the de-identification means the public thing contains no patient. Anyone can
            audit what the panel was asked.
          </RailNote>
          <FullRule />
          <RailNote title="Review bond">
            {config === null
              ? 'Set in the contract.'
              : `${(Number(BigInt(config.review_bond_atto) / 10n ** 16n) / 100).toFixed(2)} GEN, posted by whoever escalates, awarded to whoever turns out to be right.`}
          </RailNote>
        </div>
      </div>
    </section>
  );
}
