import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink, FileText, Fingerprint, Quote } from 'lucide-react';

import { Code, FullRule, Label, Panel, StatusChip } from '@/components/ui/primitives';
import { Seal } from '@/components/brand/Seal';
import { CaseActions } from '@/components/CaseActions';
import {
  advanceabilityOnChain,
  caseOnChain,
  quoteAdvance,
  verdictOnChain,
} from '@/lib/chainReads';
import { bandLabel, formatAttoRounded } from '@/lib/bands';
import { GROUND_LABELS, GROUND_DESCRIPTIONS, isGround } from '@/types/ombuds';
import { tidyProse } from '@/lib/prose';

export const dynamic = 'force-dynamic';

const DOCKET = /^OMB-\d{4}-\d{6}$/;

interface Citation {
  source?: string;
  title?: string;
  url?: string;
  locator?: string;
  digest?: string;
}

export async function generateMetadata({ params }: { params: Promise<{ docket: string }> }) {
  const { docket } = await params;
  return { title: `Docket ${docket}` };
}

export default async function CasePage({ params }: { params: Promise<{ docket: string }> }) {
  const { docket } = await params;
  if (!DOCKET.test(docket)) notFound();

  const kase = await caseOnChain(docket);
  if (kase === null) notFound();

  const hasVerdict = kase.has_verdict === true;
  const [verdict, gate, quote] = await Promise.all([
    hasVerdict ? verdictOnChain(docket) : Promise.resolve(null),
    advanceabilityOnChain(docket),
    quoteAdvance(docket),
  ]);

  const status = String(kase.status ?? 'FILED');
  const overturn = verdict?.overturn_recommended === true;
  const ground = String(verdict?.ground ?? '');
  const citations: Citation[] = Array.isArray(verdict?.citations)
    ? (verdict.citations as Citation[])
    : [];

  const sealState = verdict === null ? 'pending' : overturn ? 'overturn' : 'upheld';

  return (
    <section className="mx-auto max-w-[1240px] px-4 pb-20 pt-12">
      {/* ------------------------------------------------------------- header */}
      <div className="seq set-type flex flex-wrap items-start justify-between gap-8" style={{ ['--i' as string]: 0 }}>
        <div>
          <Label>Docket {docket}</Label>
          <h1 className="display mt-4 max-w-[32rem] text-39 text-text">
            {verdict === null
              ? 'Filed, and waiting for a panel to read it.'
              : overturn
                ? 'The denial does not survive the rule your insurer published.'
                : 'The denial stands, and here is exactly why.'}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <StatusChip status={status} />
            <span className="mono text-12 text-text-3">
              filed {String(kase.filed_at ?? '').slice(0, 10)}
            </span>
            {Number(kase.panel_round ?? 1) > 1 && (
              <span className="mono text-12 text-wait">
                panel round {String(kase.panel_round)}
              </span>
            )}
          </div>
        </div>

        <Seal docket={docket} state={sealState} />
      </div>

      <FullRule />

      {/* ------------------------------------------------- the verdict + rail */}
      <div className="mt-10 rail">
        <div className="rail-main flex flex-col gap-6">
          {verdict === null ? (
            <Panel className="p-7">
              <p className="text-16 text-text">No verdict yet.</p>
              <p className="mt-2 max-w-[42rem] text-14 text-text-2">
                Sending this to a panel means every validator fetches the bulletin and the coverage
                determination again, re-audits the codes, and reaches its own answer. They then have
                to agree on the decision, the ground, the cited clause and the payout band. That
                takes a few minutes, and it is the part that makes the result worth anything.
              </p>
            </Panel>
          ) : (
            <>
              <Panel className="p-7">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className="mono px-2 py-0.5 text-12"
                    style={{
                      borderRadius: 'var(--radius-hair)',
                      border: `1px solid ${overturn ? 'var(--win)' : 'var(--loss)'}`,
                      color: overturn ? 'var(--win)' : 'var(--loss)',
                    }}
                  >
                    {overturn ? 'overturn recommended' : 'denial upheld'}
                  </span>
                  {/* The leader's figure, labelled as the judgement it is: validators
                      agree it only to within a tolerance. The panel's exact agreement is
                      the line below, measured against the floor they ruled under. */}
                  <span className="mono text-12 text-text-3">
                    confidence {String(verdict.confidence)} of 100, as read
                  </span>
                  {verdict.crosses_confidence_band === true ? (
                    <span className="mono text-12 text-signal-bright">
                      the panel agreed it clears the money line
                      {typeof verdict.confidence_floor === 'number'
                        ? ` of ${verdict.confidence_floor}`
                        : ''}
                    </span>
                  ) : null}
                </div>

                <h2 className="display mt-5 text-25 text-text">
                  {isGround(ground) ? GROUND_LABELS[ground] : ground}
                </h2>
                <p className="mt-2 max-w-[42rem] text-14 text-text-2">
                  {isGround(ground) ? GROUND_DESCRIPTIONS[ground] : ''}
                </p>

                <FullRule />

                <p className="text-16 text-text">{tidyProse(String(verdict.reasoning ?? ''))}</p>

                {overturn && (
                  <>
                    <FullRule />
                    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                      <div>
                        <p className="mono text-12 text-text-3">In dispute</p>
                        <p className="mono tnum text-20 text-text">
                          {formatAttoRounded(BigInt(String(kase.disputed_atto ?? '0')))}
                        </p>
                      </div>
                      <div>
                        <p className="mono text-12 text-text-3">Assessed recoverable</p>
                        <p className="mono tnum text-20 text-win">
                          {bandLabel(Number(verdict.recoverable_band ?? 0))}
                        </p>
                      </div>
                    </div>
                    <p className="mt-3 max-w-[40rem] text-13 text-text-3">
                      A band, not a figure. Two careful readers will never agree on a number to the
                      cent, and the consensus rule does not ask them to.
                    </p>
                  </>
                )}
              </Panel>

              {/* The quoted clause. The whole argument, in their words. */}
              <Panel className="p-7">
                <div className="flex items-center gap-2 text-signal">
                  <Quote size={16} aria-hidden="true" />
                  <span className="mono text-12 text-text-3">
                    Their own policy, at {String(verdict.clause_section ?? '')}
                  </span>
                </div>
                <blockquote
                  className="mt-4 border-l-2 pl-5 text-20 text-text"
                  style={{ borderColor: 'var(--signal)' }}
                >
                  {tidyProse(String(verdict.clause_quote ?? ''))}
                </blockquote>
                <p className="mt-4 text-13 text-text-3">
                  Every validator checked this sentence against the document it had just fetched. A
                  quote that could not be found would have raised an error and sent the case to a
                  fresh panel instead of being written down.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Code>{String(verdict.clause_id ?? '')}</Code>
                  <span className="mono text-12 text-text-3">compared exactly across validators</span>
                </div>
              </Panel>

              <CaseActions
                docket={docket}
                hasVerdict
                status={status}
                advanceable={gate?.ok === true}
                advanceReason={gate?.reason ?? ''}
                quoteAmountAtto={quote?.eligible === true ? quote.amount_atto : null}
                quoteLimitedBy={quote?.limited_by ?? null}
                panelRound={Number(kase.panel_round ?? 1)}
              />
            </>
          )}

          {verdict === null && (
            <CaseActions
              docket={docket}
              hasVerdict={false}
              status={status}
              advanceable={false}
              advanceReason=""
              quoteAmountAtto={null}
              quoteLimitedBy={null}
              panelRound={Number(kase.panel_round ?? 1)}
            />
          )}

          {/* ------------------------------------------------ the case record */}
          <Panel className="p-7">
            <p className="mono text-12 text-text-3">
              The whole case record, which is everything that is public
            </p>
            <dl className="mt-4 flex flex-col gap-3">
              {[
                ['Plan rule', String(kase.plan_id ?? '')],
                ['Procedure family', String(kase.family_id ?? '').replace(/_/g, ' ')],
                ['State', String(kase.state ?? '')],
                ['Month of service', String(kase.service_month ?? '')],
                ['Denial reason code', String(kase.denial_reason_code ?? '') || 'not stated'],
              ].map(([key, value]) => (
                <div key={key} className="flex flex-wrap items-baseline gap-x-4">
                  <dt className="mono w-[11rem] shrink-0 text-12 text-text-3">{key}</dt>
                  <dd className="mono text-13 text-text">{value}</dd>
                </div>
              ))}

              <div className="flex flex-wrap items-baseline gap-x-4">
                <dt className="mono w-[11rem] shrink-0 text-12 text-text-3">Procedure codes</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {(Array.isArray(kase.cpt_codes) ? kase.cpt_codes : []).map((code) => (
                    <Code key={String(code)}>{String(code)}</Code>
                  ))}
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-4">
                <dt className="mono w-[11rem] shrink-0 text-12 text-text-3">Diagnosis codes</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {(Array.isArray(kase.icd10_codes) ? kase.icd10_codes : []).map((code) => (
                    <Code key={String(code)}>{String(code)}</Code>
                  ))}
                </dd>
              </div>

              <FullRule />

              <div>
                <dt className="mono text-12 text-text-3">Their stated rationale, verbatim</dt>
                <dd className="mt-2 text-14 text-text">{tidyProse(String(kase.denial_rationale ?? ''))}</dd>
              </div>
            </dl>
          </Panel>
        </div>

        {/* ------------------------------------------------- the citation rail */}
        <div className="rail-aside flex flex-col gap-7">
          <div>
            <Label>Sources</Label>
            <p className="mt-2 text-13 text-text-3">
              Each one re-fetched by every validator. Follow them and check us.
            </p>
          </div>

          {citations.length === 0 ? (
            <p className="mono text-12 text-text-3">
              Citations appear once a panel has returned a verdict.
            </p>
          ) : (
            citations.map((citation, index) => (
              <aside key={`${citation.url}-${index}`} className="rail-tie">
                <p className="mono text-12 text-text-3">
                  <span className="tnum text-signal-bright">{`[${index + 1}] `}</span>
                  {citation.source}
                </p>
                {citation.locator !== undefined && citation.locator !== '' && (
                  <p className="mt-1 text-13 text-text-2">at {citation.locator}</p>
                )}
                {citation.url !== undefined && (
                  <a
                    href={citation.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mono mt-1 inline-flex items-start gap-1 break-all text-12 text-signal-bright hover:underline"
                  >
                    {citation.url.replace(/^https:\/\//, '')}
                    <ExternalLink size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
                  </a>
                )}
                {citation.digest !== undefined && citation.digest !== '' && (
                  <p className="mono mt-1 text-12 text-text-3" title={citation.digest}>
                    digest {citation.digest.slice(0, 12)}
                  </p>
                )}
              </aside>
            ))
          )}

          <FullRule />

          <aside>
            <p className="mono flex items-center gap-1.5 text-12 text-text-3">
              <Fingerprint size={12} aria-hidden="true" />
              Commitments
            </p>
            <p className="mono mt-2 break-all text-12 text-text-2">
              letter {String(kase.evidence_sha256 ?? '').slice(0, 24)}
            </p>
            {verdict !== null && (
              <p className="mono mt-1 break-all text-12 text-text-2">
                verdict {String(verdict.digest ?? '').slice(0, 24)}
              </p>
            )}
            <p className="mt-2 text-13 text-text-3">
              The letter itself was never uploaded. The hash proves which document you were holding.
            </p>
          </aside>

          {verdict !== null && (
            <>
              <FullRule />
              <a
                href={`/api/cases/${docket}/letter`}
                className="mono inline-flex items-center gap-1.5 text-13 text-signal-bright hover:underline"
              >
                <FileText size={13} aria-hidden="true" />
                Download the appeal letter
              </a>
            </>
          )}

          <FullRule />
          <Link href="/docket" className="mono text-12 text-text-3 hover:text-text">
            Back to the docket
          </Link>
        </div>
      </div>
    </section>
  );
}
