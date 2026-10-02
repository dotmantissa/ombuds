import Link from 'next/link';
import { Gavel, Scale } from 'lucide-react';

import { Code, FullRule, Label, Panel, Stat, StatusChip } from '@/components/ui/primitives';
import { courtStats, docketPage } from '@/lib/chainReads';
import { bandLabel, formatAttoRounded } from '@/lib/bands';
import { GROUND_LABELS, isGround } from '@/types/ombuds';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'The docket' };

export default async function DocketPage() {
  const [stats, rows] = await Promise.all([courtStats(), docketPage(0, 40)]);
  const cases = rows ?? [];

  const overturnRate =
    stats !== null && stats.verdict_count > 0
      ? Math.round((stats.overturn_count / stats.verdict_count) * 100)
      : null;

  return (
    <section className="mx-auto max-w-[1240px] px-4 pb-20 pt-12">
      <div className="seq set-type" style={{ ['--i' as string]: 0 }}>
        <Label>Public record, read from the contract</Label>
        <h1 className="display mt-4 max-w-[34rem] text-49 text-text">
          Every case this court has decided, and what it decided.
        </h1>
        <p className="mt-5 max-w-[44rem] text-16 text-text-2">
          Nothing here identifies anybody. A row is a plan rule, a procedure family, a state, a
          month and a decision. That is the whole point of the privacy design: the public record can
          be genuinely public.
        </p>
      </div>

      <Panel className="mt-9 p-6">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Stat value={stats?.case_count ?? '--'} caption="Cases filed" />
          <Stat value={stats?.verdict_count ?? '--'} caption="Verdicts issued" />
          <Stat
            value={overturnRate === null ? '--' : `${overturnRate}%`}
            caption="Recommended for overturn"
            tone="win"
          />
          <Stat
            value={
              stats === null ? '--' : formatAttoRounded(BigInt(stats.total_disputed_atto))
            }
            caption="Total in dispute across the docket"
            tone="signal"
          />
        </div>

        {stats !== null && Object.values(stats.grounds).some((n) => n > 0) && (
          <>
            <FullRule />
            <p className="mono text-12 text-text-3">Grounds the court has found</p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {Object.entries(stats.grounds)
                .filter(([, count]) => count > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([ground, count]) => (
                  <li key={ground}>
                    <Code>
                      {isGround(ground) ? GROUND_LABELS[ground] : ground} &times; {count}
                    </Code>
                  </li>
                ))}
            </ul>
          </>
        )}
      </Panel>

      {cases.length === 0 ? (
        <Panel className="mt-8 p-8 text-center">
          <Scale size={22} className="mx-auto text-text-3" aria-hidden="true" />
          <p className="mt-3 text-16 text-text">Nothing on the docket yet.</p>
          <p className="mx-auto mt-2 max-w-[32rem] text-14 text-text-2">
            The court is deployed and the rules are registered. The first case will show up here the
            moment somebody files one.
          </p>
          <Link
            href="/file"
            className="mt-5 inline-flex h-10 items-center gap-2 border border-signal bg-signal px-4 text-14 font-medium text-white"
            style={{ borderRadius: 'var(--radius-hair)' }}
          >
            <Gavel size={15} aria-hidden="true" />
            File the first one
          </Link>
        </Panel>
      ) : (
        <div
          className="mt-8 overflow-x-auto border border-line"
          style={{ borderRadius: 'var(--radius-hair)' }}
        >
          <table className="w-full min-w-[60rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-raised">
                {['Docket', 'Plan rule', 'State', 'In dispute', 'Decision', 'Ground', 'Recoverable', 'Status'].map(
                  (head) => (
                    <th key={head} className="mono px-4 py-3 text-12 font-normal text-text-3">
                      {head}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {cases.map((row, index) => (
                <tr
                  key={row.docket}
                  className="seq stamp-in border-b border-line last:border-b-0 hover:bg-raised"
                  style={{ ['--i' as string]: Math.min(index, 12) }}
                >
                  <td className="px-4 py-3.5">
                    <Link
                      href={`/case/${row.docket}`}
                      className="mono tnum text-13 text-signal-bright hover:underline"
                    >
                      {row.docket}
                    </Link>
                  </td>
                  <td className="px-4 py-3.5">
                    <p className="text-13 text-text">{row.plan_id.split('-')[0]}</p>
                    <p className="mono text-12 text-text-3">{row.family_id.replace(/_/g, ' ')}</p>
                  </td>
                  <td className="mono px-4 py-3.5 text-13 text-text-2">{row.state}</td>
                  <td className="mono tnum px-4 py-3.5 text-13 text-text-2">
                    {formatAttoRounded(BigInt(row.disputed_atto))}
                  </td>
                  <td className="px-4 py-3.5">
                    {row.ground === '' ? (
                      <span className="mono text-12 text-text-3">awaiting a panel</span>
                    ) : (
                      <span
                        className="mono text-12"
                        style={{ color: row.overturn_recommended ? 'var(--win)' : 'var(--loss)' }}
                      >
                        {row.overturn_recommended ? 'overturn' : 'upheld'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-13 text-text-2">
                    {row.ground === ''
                      ? '--'
                      : isGround(row.ground)
                        ? GROUND_LABELS[row.ground]
                        : row.ground}
                  </td>
                  <td className="mono tnum px-4 py-3.5 text-12 text-text-2">
                    {row.ground === '' ? '--' : bandLabel(row.recoverable_band)}
                  </td>
                  <td className="px-4 py-3.5">
                    <StatusChip status={row.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mono mt-6 text-12 text-text-3">
        This table is read straight off the OmbudsCourt contract. The search index is used for
        filtering and history, and it is never the reason a verdict is believed.
      </p>
    </section>
  );
}
