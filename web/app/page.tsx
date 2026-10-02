import Link from 'next/link';
import { ArrowUpRight, FileSearch, Gavel, Landmark, ShieldCheck, Wallet } from 'lucide-react';

import { Code, FullRule, Label, Panel, RailNote, Stat } from '@/components/ui/primitives';
import { Mark } from '@/components/brand/Mark';
import { courtConfig, courtStats, planRules, poolStats, registryStats } from '@/lib/chainReads';
import { formatAttoRounded } from '@/lib/bands';

export const dynamic = 'force-dynamic';

function gen(atto: string | undefined): string {
  if (atto === undefined) return 'unavailable';
  try {
    const value = BigInt(atto);
    const whole = value / 10n ** 18n;
    const frac = ((value % 10n ** 18n) * 100n) / 10n ** 18n;
    return `${whole}.${frac.toString().padStart(2, '0')} GEN`;
  } catch {
    return 'unavailable';
  }
}

export default async function Home() {
  const [registry, court, pool, config, rules] = await Promise.all([
    registryStats(),
    courtStats(),
    poolStats(),
    courtConfig(),
    planRules(),
  ]);

  const refreshed = rules.filter((r) => r.content_hash !== '').length;

  return (
    <>
      {/* ---------------------------------------------------------------- hero */}
      <section className="mx-auto max-w-[1240px] px-4 pb-16 pt-14 md:pt-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
          <div>
            <div className="seq set-type" style={{ ['--i' as string]: 0 }}>
              <Label>Docket open since October 2026</Label>
            </div>

            <h1
              className="seq set-type display mt-5 text-61 text-text"
              style={{ ['--i' as string]: 1 }}
            >
              Your insurer wrote the rule.
              <br />
              <span className="text-signal-bright">Let us read it back to them.</span>
            </h1>

            <div className="seq set-type mt-7 max-w-[46rem]" style={{ ['--i' as string]: 2 }}>
              <p className="text-20 text-text-2">
                Roughly four in five denied claims are never appealed. Not because people agree
                with the denial, but because winning means reading your plan document, the
                insurer&apos;s clinical policy bulletin, the right procedure codes and your
                state&apos;s review law, and holding all four against each other at once.
              </p>
              <p className="mt-4 text-16 text-text-2">
                Every one of those documents is public. Assembling them is the part that beats
                people. So Ombuds assembles them, puts the verdict on a public ledger where
                several independent validators had to agree on it, and hands you a letter with
                the citations already in it.
              </p>
            </div>

            <div className="seq set-type mt-9 flex flex-wrap items-center gap-3" style={{ ['--i' as string]: 3 }}>
              <Link
                href="/file"
                className="inline-flex h-11 items-center gap-2 border border-signal bg-signal px-5 text-16 font-medium text-white transition-opacity hover:opacity-90"
                style={{ borderRadius: 'var(--radius-hair)' }}
              >
                <FileSearch size={17} aria-hidden="true" />
                Read my denial letter
              </Link>
              <Link
                href="/docket"
                className="inline-flex h-11 items-center gap-2 border border-line bg-surface px-5 text-16 text-text transition-colors hover:border-line-strong"
                style={{ borderRadius: 'var(--radius-hair)' }}
              >
                <Gavel size={17} aria-hidden="true" />
                See what the court has decided
              </Link>
            </div>

            <p className="seq set-type mono mt-6 text-12 text-text-3" style={{ ['--i' as string]: 4 }}>
              Email sign in. No wallet, no seed phrase, no gas. Nothing identifying a patient
              ever reaches the chain.
            </p>
          </div>

          {/* The supporting rail. Live readings off the three contracts, not decoration. */}
          <aside
            className="seq set-type lg:border-l lg:border-line lg:pl-7"
            style={{ ['--i' as string]: 2 }}
            aria-label="Live chain readings"
          >
            <Label>Read from chain just now</Label>
            <dl className="mt-5 flex flex-col gap-5">
              <div>
                <dt className="text-13 text-text-2">Coverage rules under watch</dt>
                <dd className="mono tnum mt-1 text-31 leading-none text-text">
                  {registry?.active_count ?? '--'}
                </dd>
                <p className="mono mt-1.5 text-12 text-text-3">
                  {refreshed} with a consensus digest recorded
                </p>
              </div>
              <FullRule />
              <div>
                <dt className="text-13 text-text-2">Cases decided</dt>
                <dd className="mono tnum mt-1 text-31 leading-none text-text">
                  {court?.verdict_count ?? '--'}
                </dd>
                <p className="mono mt-1.5 text-12 text-text-3">
                  {court?.overturn_count ?? 0} recommended for overturn
                </p>
              </div>
              <FullRule />
              <div>
                <dt className="text-13 text-text-2">Capital in escrow</dt>
                <dd className="mono tnum mt-1 text-31 leading-none text-signal-bright">
                  {gen(pool?.total_value_governed_atto)}
                </dd>
                <p className="mono mt-1.5 text-12 text-text-3">
                  {pool?.underwriter_count ?? 0} underwriter
                  {(pool?.underwriter_count ?? 0) === 1 ? '' : 's'} behind the advances
                </p>
              </div>
            </dl>
          </aside>
        </div>
      </section>

      <FullRule strong />

      {/* ------------------------------------------------- the trust problem */}
      <section className="mx-auto max-w-[1240px] px-4 py-16">
        <div className="rail">
          <div className="rail-main">
            <Label>The thing nobody says out loud</Label>
            <h2 className="display mt-4 max-w-[34rem] text-39 text-text">
              When your insurer denies a claim, your insurer decides whether the denial was
              correct.
            </h2>
            <div className="mt-6 max-w-[42rem] space-y-4 text-16 text-text-2">
              <p>
                That is what an internal appeal is. The party that keeps the money if the answer
                is no gets to write the answer. Everyone involved knows this, and it is somehow
                still how the system works.
              </p>
              <p>
                An off-chain chatbot telling you &ldquo;this denial looks wrong&rdquo; does not
                fix it, because your insurer will not accept a chatbot&apos;s opinion and neither
                will a state regulator. What carries weight is a verdict that several independent
                parties reached by each reading the same public documents, that is timestamped
                and cannot be edited afterwards, that shows its citations, and that had real money
                staked on being right.
              </p>
              <p className="text-text">
                That is a consensus object, not a guess. And once it is trustworthy, capital will
                advance against it, which is how a member gets paid this week instead of next
                spring.
              </p>
            </div>
          </div>

          <div className="rail-aside flex flex-col gap-6">
            <RailNote index={1} title="What a validator re-reads">
              The insurer&apos;s own clinical policy bulletin, at the same URL, fetched again by
              every validator independently.
            </RailNote>
            <RailNote index={2} title="Federal coverage criteria">
              The CMS National Coverage Determination for the procedure, straight from the
              coverage database API.
            </RailNote>
            <RailNote index={3} title="Your state's review law">
              The statute and the deadline that applies where you live, which goes into the letter.
            </RailNote>
            <RailNote index={4} title="Codes, checked by code">
              Procedure and diagnosis codes are verified by running code, never by asking a model.
            </RailNote>
          </div>
        </div>
      </section>

      <FullRule />

      {/* ----------------------------------------- the four compared fields */}
      <section className="mx-auto max-w-[1240px] px-4 py-16">
        <Label>How agreement is actually measured</Label>
        <h2 className="display mt-4 max-w-[38rem] text-39 text-text">
          A validator does not read the leader&apos;s reasoning and nod along. It does the whole
          job again, then compares four things.
        </h2>
        <p className="mt-5 max-w-[46rem] text-16 text-text-2">
          Free text is handled differently from decisions. Two careful readers will never agree on
          a dollar figure, and they do not need to. They need to agree on what was decided, on
          what grounds, against which clause, and roughly how much is at stake.
        </p>

        <ol className="mt-9 grid gap-0 border border-line md:grid-cols-2" style={{ borderRadius: 'var(--radius-hair)' }}>
          {[
            {
              field: 'overturn_recommended',
              rule: 'Exact match',
              why: 'The decision itself. There is no partial credit on whether a denial stands.',
            },
            {
              field: 'ground',
              rule: 'Exact match, five values',
              why: 'Disagreeing about whether this is a coding error or a medical necessity dispute is a real disagreement, because it changes the letter and the statute you file under.',
            },
            {
              field: 'clause_id',
              rule: 'Exact match',
              why: 'The section of the bulletin being turned against the denial. This is the anti hallucination clamp, and it is checkable precisely because both sides just re-fetched the document.',
            },
            {
              field: 'recoverable_band',
              rule: 'Same discrete band',
              why: 'A band, never a figure. Nobody agrees on $4,312.88. Everybody can agree the money sits between two thousand and seven and a half thousand.',
            },
          ].map((row, index) => (
            <li
              key={row.field}
              className={`seq stamp-in p-6 ${index % 2 === 0 ? 'md:border-r' : ''} ${index < 2 ? 'border-b' : ''} border-line`}
              style={{ ['--i' as string]: index }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Code>{row.field}</Code>
                <span className="mono text-12 text-signal-bright">{row.rule}</span>
              </div>
              <p className="mt-3 text-14 text-text-2">{row.why}</p>
            </li>
          ))}
        </ol>

        <Panel className="mt-6 p-6">
          <div className="flex items-start gap-4">
            <span className="mt-0.5 shrink-0 text-signal">
              <ShieldCheck size={18} aria-hidden="true" />
            </span>
            <div>
              <p className="text-16 text-text">
                A quoted clause has to exist in the document the validator just fetched.
              </p>
              <p className="mt-2 max-w-[54rem] text-14 text-text-2">
                The quote is not compared between validators, because two readers can cite
                different sentences from the same section and both be right. Instead each
                validator checks its own citation against the source. A sentence that cannot be
                found raises an error and forces a fresh panel, so a fabricated citation cannot be
                written into the record. Divergence on any of the four fields above does the same
                thing.
              </p>
            </div>
          </div>
        </Panel>
      </section>

      <FullRule />

      {/* ------------------------------------------------- the live registry */}
      <section className="mx-auto max-w-[1240px] px-4 py-16">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Label>On chain right now</Label>
            <h2 className="display mt-4 text-39 text-text">The rules we are allowed to argue from</h2>
            <p className="mt-4 max-w-[44rem] text-16 text-text-2">
              Each of these is a real published bulletin. The digest is a fingerprint of its policy
              text, agreed by every validator independently. If an insurer quietly rewrites one mid
              year, the digest moves and the registry records it as a revision.
            </p>
          </div>
          <Link
            href="/sources"
            className="mono inline-flex items-center gap-1.5 text-13 text-signal-bright hover:underline"
          >
            Every source we read
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        </div>

        {rules.length === 0 ? (
          <Panel className="mt-8 p-6">
            <p className="text-14 text-text-2">
              The registry is not answering at the moment. The rules are on chain either way, and
              this page will show them again as soon as the endpoint comes back.
            </p>
          </Panel>
        ) : (
          <div className="mt-8 overflow-x-auto border border-line" style={{ borderRadius: 'var(--radius-hair)' }}>
            <table className="w-full min-w-[56rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-raised">
                  {['Plan rule', 'Published bulletin', 'In force', 'Policy digest', 'Sections'].map((head) => (
                    <th key={head} className="mono px-4 py-3 text-12 font-normal text-text-3">
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rules.map((rule, index) => (
                  <tr
                    key={rule.plan_id}
                    className="seq stamp-in border-b border-line last:border-b-0"
                    style={{ ['--i' as string]: index }}
                  >
                    <td className="px-4 py-3.5 align-top">
                      <p className="text-14 text-text">{rule.insurer}</p>
                      <p className="mono mt-0.5 text-12 text-text-3">
                        {rule.family_id.replace(/_/g, ' ')}
                      </p>
                    </td>
                    <td className="px-4 py-3.5 align-top">
                      <a
                        href={rule.bulletin_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-14 text-text hover:text-signal-bright hover:underline"
                      >
                        {rule.bulletin_title || `Bulletin ${rule.bulletin_number}`}
                      </a>
                      <p className="mono mt-0.5 text-12 text-text-3">
                        CPB {rule.bulletin_number}
                        {rule.cms_display_id !== '' && ` with CMS ${rule.cms_display_id}`}
                      </p>
                    </td>
                    <td className="mono tnum px-4 py-3.5 align-top text-12 text-text-2">
                      {rule.effective_from}
                      <br />
                      to {rule.effective_to}
                    </td>
                    <td className="px-4 py-3.5 align-top">
                      {rule.content_hash === '' ? (
                        <span className="mono text-12 text-text-3">not yet refreshed</span>
                      ) : (
                        <span className="mono text-12 text-win" title={rule.content_hash}>
                          {rule.content_hash.slice(0, 16)}
                        </span>
                      )}
                      {rule.revision_count > 0 && (
                        <p className="mono mt-1 text-12 text-wait">
                          {rule.revision_count} silent revision
                          {rule.revision_count === 1 ? '' : 's'} caught
                        </p>
                      )}
                    </td>
                    <td className="mono tnum px-4 py-3.5 align-top text-12 text-text-2">
                      {rule.clause_sections.length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <FullRule />

      {/* -------------------------------------------------------- the money */}
      <section className="mx-auto max-w-[1240px] px-4 py-16">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div>
            <Label>Why a good verdict is not enough</Label>
            <h2 className="display mt-4 max-w-[32rem] text-39 text-text">
              Being right in March does not pay a bill that was due in January.
            </h2>
            <div className="mt-6 max-w-[42rem] space-y-4 text-16 text-text-2">
              <p>
                Winning an appeal takes months. Internal review, then external review, then the
                actual cheque. Most people give up somewhere in the middle, which is precisely
                why denials work as a business practice.
              </p>
              <p>
                So underwriters put capital behind the verdicts. When a verdict recommends
                overturning and clears the confidence band, the pool advances a share of the
                disputed amount to the member straight away. When the insurer eventually pays, the
                pool takes its principal back plus a fee and the rest goes to the member. When the
                insurer never pays, the underwriters take the loss, openly, on chain.
              </p>
              <p className="text-text">
                No human decides when that money moves. The pool reads the court, and the court
                only says yes when the validators agreed.
              </p>
            </div>
            <Link
              href="/pool"
              className="mono mt-7 inline-flex items-center gap-1.5 text-14 text-signal-bright hover:underline"
            >
              <Wallet size={14} aria-hidden="true" />
              Look at the pool
            </Link>
          </div>

          <Panel className="p-7">
            <div className="flex items-center gap-2 text-signal">
              <Mark size={18} />
              <span className="mono text-12 text-text-3">Pool terms, from the contract</span>
            </div>
            <div className="mt-6 flex flex-col gap-6">
              <Stat
                value={gen(pool?.total_value_governed_atto)}
                caption="Total value governed, which is capital actually in escrow"
                tone="signal"
              />
              <FullRule />
              <Stat value={gen(pool?.free_capital_atto)} caption="Free to advance today" />
              <FullRule />
              <Stat
                value={`${config?.min_confidence ?? '--'} of 100`}
                caption="The confidence a verdict has to clear before any money moves"
              />
              <FullRule />
              <Stat
                value={gen(pool?.outstanding_atto)}
                caption="Out with members, waiting on an insurer"
                tone="wait"
              />
            </div>
          </Panel>
        </div>
      </section>

      <FullRule />

      {/* ------------------------------------------------------------ privacy */}
      <section className="mx-auto max-w-[1240px] px-4 py-16">
        <div className="rail">
          <div className="rail-main">
            <Label>Said loudly on purpose</Label>
            <h2 className="display mt-4 max-w-[34rem] text-39 text-text">
              Nothing that identifies a patient goes on the chain. Not once, not ever.
            </h2>
            <div className="mt-6 max-w-[42rem] space-y-4 text-16 text-text-2">
              <p>
                Prompts are public on GenLayer. That is a feature, because it is how anyone can
                audit what the panel was asked. It also means the public thing has to contain no
                patient, so the design starts there rather than bolting privacy on afterwards.
              </p>
              <p>
                Your letter is reduced to a de-identified record before anything is signed:
                procedure and diagnosis codes, the denial reason code, one scrubbed sentence of the
                insurer&apos;s own rationale, a plan identifier, a state, and the month of service.
                The document itself is hashed and the hash is all that is committed.
              </p>
              <p className="text-text">
                Then the contract runs its own check over the same fields and refuses the filing if
                anything that looks like a member id, a phone number, an email address or a full
                date got through. Two independent checks, written at different layers, and a filing
                has to pass both.
              </p>
            </div>
            <Link
              href="/privacy"
              className="mono mt-7 inline-flex items-center gap-1.5 text-14 text-signal-bright hover:underline"
            >
              <Landmark size={14} aria-hidden="true" />
              What stays private, in detail
            </Link>
          </div>

          <div className="rail-aside flex flex-col gap-6">
            <RailNote title="Never leaves your browser">
              Your name, your member id, your date of birth, the raw letter, the full date of
              service.
            </RailNote>
            <RailNote title="Committed as a hash only">
              The original document, as a SHA-256, so you can prove later which letter you were
              holding.
            </RailNote>
            <RailNote title="The index is not the record">
              Search runs on a database, but a verdict is always re-read from the contract before
              it is shown. The index cannot invent or alter a verdict.
            </RailNote>
          </div>
        </div>
      </section>

      <FullRule strong />

      <section className="mx-auto max-w-[1240px] px-4 py-20">
        <div className="flex flex-col items-start gap-6 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="display max-w-[30rem] text-49 text-text">
              You already have everything you need to win. It is just spread across four documents.
            </h2>
            <p className="mt-4 max-w-[38rem] text-16 text-text-2">
              Paste the denial letter. We will tell you which codes it turns on, which published
              rule applies, and whether the denial survives it.
            </p>
          </div>
          <Link
            href="/file"
            className="inline-flex h-12 shrink-0 items-center gap-2 border border-signal bg-signal px-6 text-16 font-medium text-white transition-opacity hover:opacity-90"
            style={{ borderRadius: 'var(--radius-hair)' }}
          >
            <FileSearch size={18} aria-hidden="true" />
            Start a case
          </Link>
        </div>
        <p className="mono mt-8 text-12 text-text-3">
          Ombuds argues about coverage, never about treatment. Total disputed across the docket so
          far: {court === null ? 'unavailable' : formatAttoRounded(BigInt(court.total_disputed_atto))}.
        </p>
      </section>
    </>
  );
}
