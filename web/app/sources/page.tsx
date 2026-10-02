import { CheckCircle2, CircleSlash, ExternalLink } from 'lucide-react';

import { Code, FullRule, Label, Panel } from '@/components/ui/primitives';
import { loadSources, type SourceDataset } from '@/lib/sources';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sources we read' };

function Checked({ verification }: { verification?: { http_status: number | string; observed_at: string; reachable: boolean } }) {
  if (verification === undefined) return null;
  const ok = verification.reachable;
  return (
    <span
      className="mono inline-flex items-center gap-1 text-12"
      style={{ color: ok ? 'var(--win)' : 'var(--wait)' }}
      title={`observed ${verification.observed_at}`}
    >
      {ok ? <CheckCircle2 size={11} aria-hidden="true" /> : <CircleSlash size={11} aria-hidden="true" />}
      {String(verification.http_status)}
    </span>
  );
}

export default async function SourcesPage() {
  const data: SourceDataset | null = await loadSources();

  if (data === null) {
    return (
      <section className="mx-auto max-w-[1240px] px-4 py-16">
        <h1 className="display text-39 text-text">Sources we read</h1>
        <p className="mt-4 text-16 text-text-2">
          The dataset is not readable right now. It lives at data/sources.json in the repository and
          is served from there.
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-[1240px] px-4 pb-20 pt-12">
      <div className="seq set-type" style={{ ['--i' as string]: 0 }}>
        <Label>Checked, with the status we actually got</Label>
        <h1 className="display mt-4 max-w-[34rem] text-49 text-text">
          Everything Ombuds reads, and nothing it does not.
        </h1>
        <p className="mt-5 max-w-[46rem] text-16 text-text-2">{data.meta.verification_method}</p>
        <p className="mt-3 max-w-[46rem] text-14 text-text-3">{data.meta.fetchable_on_chain_note}</p>
      </div>

      {/* procedure families */}
      <h2 className="display mt-14 text-31 text-text">Procedure families</h2>
      <div className="mt-6 flex flex-col gap-5">
        {data.procedure_families.map((family, index) => (
          <Panel key={family.family_id} className="seq stamp-in p-6" style={{ ['--i' as string]: index }}>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <h3 className="display text-25 text-text">{family.label}</h3>
                <p className="mt-1 text-14 text-text-2">{family.plain_language}</p>
              </div>
              {family.ncd !== null && <Checked verification={family.ncd.verification} />}
            </div>

            <FullRule />

            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <p className="mono text-12 text-text-3">Procedure and supply codes</p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {family.cpt_codes.map((row) => (
                    <li key={row.code} className="flex items-baseline gap-2.5">
                      <Code>{row.code}</Code>
                      <span className="text-13 text-text-2">{row.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mono text-12 text-text-3">Diagnosis codes</p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {family.icd10_codes.map((row) => (
                    <li key={row.code} className="flex items-baseline gap-2.5">
                      <Code>{row.code}</Code>
                      <span className="text-13 text-text-2">{row.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <FullRule />

            <div className="flex flex-col gap-2">
              {family.ncd === null ? (
                <p className="text-13 text-wait">
                  There is no federal coverage determination for this procedure. A sweep of all 345
                  determinations found none, so this family is argued on the insurer bulletin alone
                  rather than against a determination we pretended to find.
                </p>
              ) : (
                <a
                  href={family.ncd.api_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mono inline-flex items-center gap-1.5 break-all text-12 text-signal-bright hover:underline"
                >
                  CMS {family.ncd.display_id}, {family.ncd.title}
                  <ExternalLink size={11} className="shrink-0" aria-hidden="true" />
                </a>
              )}
              {family.guideline !== undefined && (
                <a
                  href={family.guideline.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mono inline-flex items-center gap-1.5 break-all text-12 text-text-2 hover:text-signal-bright hover:underline"
                >
                  {family.guideline.body}
                  <ExternalLink size={11} className="shrink-0" aria-hidden="true" />
                </a>
              )}
            </div>
          </Panel>
        ))}
      </div>

      {/* states */}
      <h2 className="display mt-14 text-31 text-text">External review, state by state</h2>
      <p className="mt-3 max-w-[46rem] text-16 text-text-2">
        The citation and the deadline are the substantive data here, and both come from the statute.
        Several state sites refuse scripted requests, which is recorded rather than hidden. These
        pages are citations for your letter and are not fetched during consensus.
      </p>
      <div className="mt-6 overflow-x-auto border border-line" style={{ borderRadius: 'var(--radius-hair)' }}>
        <table className="w-full min-w-[52rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-line bg-raised">
              {['State', 'Agency', 'Statute', 'Window', 'Mechanism'].map((head) => (
                <th key={head} className="mono px-4 py-3 text-12 font-normal text-text-3">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.states.map((row) => (
              <tr key={row.state} className="border-b border-line last:border-b-0">
                <td className="px-4 py-3">
                  <span className="mono text-13 text-text">{row.state}</span>
                  <p className="text-12 text-text-3">{row.state_name}</p>
                </td>
                <td className="px-4 py-3 text-13 text-text-2">{row.agency}</td>
                <td className="px-4 py-3">
                  <a
                    href={row.statute_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mono text-12 text-signal-bright hover:underline"
                  >
                    {row.statute_citation}
                  </a>
                </td>
                <td className="mono tnum px-4 py-3 text-13 text-text">
                  {row.external_review_deadline_days} days
                  {row.follows_federal_default && (
                    <span className="block text-12 text-text-3">federal default</span>
                  )}
                </td>
                <td className="px-4 py-3 text-13 text-text-2">{row.mechanism}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mono mt-3 text-12 text-text-3">
        Federal fallback: {data.federal_external_review.citation}, a{' '}
        {data.federal_external_review.default_request_window_days} day window.
      </p>

      {/* reason codes */}
      <h2 className="display mt-14 text-31 text-text">Denial reason codes</h2>
      <div className="mt-6 flex flex-col gap-2">
        {data.denial_reason_codes.map((row) => (
          <div key={`${row.set}-${row.code}`} className="flex flex-wrap items-baseline gap-3 border-b border-line pb-2">
            <Code>
              {row.set} {row.code}
            </Code>
            <span className="text-14 text-text-2">{row.description}</span>
            <span className="mono text-12 text-signal-bright">{row.maps_to_ground}</span>
          </div>
        ))}
      </div>

      {/* rejected */}
      <h2 className="display mt-14 text-31 text-text">What we rejected, and why</h2>
      <div className="mt-6 flex flex-col gap-4">
        {data.meta.rejected.map((row) => (
          <Panel key={row.source} className="p-6">
            <p className="text-16 text-text">{row.source}</p>
            <p className="mono mt-1 break-all text-12 text-text-3">{row.url}</p>
            <p className="mt-3 max-w-[48rem] text-14 text-text-2">{row.reason}</p>
          </Panel>
        ))}
      </div>

      <p className="mono mt-10 text-12 text-text-3">
        Dataset generated {data.meta.generated_at}. Rebuild it with python3 scripts/build_sources.py,
        which re-requests every URL and records what came back.
      </p>
    </section>
  );
}
