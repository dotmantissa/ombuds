import { Coins, TrendingDown, TrendingUp } from 'lucide-react';

import { FullRule, Label, Panel, RailNote, Stat } from '@/components/ui/primitives';
import { advanceLedger, poolConfig, poolStats } from '@/lib/chainReads';
import { bandLabel } from '@/lib/bands';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Advance pool' };

function genOf(atto: string | undefined): string {
  if (atto === undefined) return '--';
  try {
    const value = BigInt(atto);
    const whole = value / 10n ** 18n;
    const frac = ((value % 10n ** 18n) * 100n) / 10n ** 18n;
    return `${whole}.${frac.toString().padStart(2, '0')}`;
  } catch {
    return '--';
  }
}

export default async function PoolPage() {
  const [stats, config, ledger] = await Promise.all([poolStats(), poolConfig(), advanceLedger(25)]);
  const rows = ledger ?? [];

  return (
    <section className="mx-auto max-w-[1240px] px-4 pb-20 pt-12">
      <div className="rail">
        <div className="rail-main">
          <div className="seq set-type" style={{ ['--i' as string]: 0 }}>
            <Label>Capital that moves without anyone deciding</Label>
            <h1 className="display mt-4 max-w-[32rem] text-49 text-text">
              Somebody has to pay the bill before the insurer gets round to it.
            </h1>
            <p className="mt-5 max-w-[44rem] text-16 text-text-2">
              Underwriters put capital in here. When a verdict recommends overturning and clears the
              confidence band, the pool advances a share of the disputed amount to the member
              immediately. When the insurer pays, the pool takes its principal back plus a fee and
              the rest goes to the member. When the insurer never pays, the underwriters eat it.
            </p>
            <p className="mt-4 max-w-[44rem] text-16 text-text-2">
              That is only a sane risk to take because the verdict underneath it is a consensus
              object with an auditable evidence trail, rather than one model&apos;s opinion. The
              pool calls no model and fetches nothing. It reads the court.
            </p>
          </div>

          <Panel className="mt-9 p-7">
            <div className="flex items-center gap-2 text-signal">
              <Coins size={17} aria-hidden="true" />
              <span className="mono text-12 text-text-3">Escrow, read from the contract</span>
            </div>
            <div className="mt-6 grid gap-7 sm:grid-cols-2">
              <Stat
                value={`${genOf(stats?.total_value_governed_atto)} GEN`}
                caption="Total value governed"
                tone="signal"
              />
              <Stat value={`${genOf(stats?.free_capital_atto)} GEN`} caption="Free to advance" />
              <Stat
                value={`${genOf(stats?.outstanding_atto)} GEN`}
                caption="Out with members, waiting on an insurer"
                tone="wait"
              />
              <Stat
                value={`${((stats?.utilisation_bps ?? 0) / 100).toFixed(1)}%`}
                caption={`Utilisation, capped at ${((config?.max_utilisation_bps ?? 0) / 100).toFixed(0)}%`}
              />
            </div>

            <FullRule />

            <div className="grid gap-7 sm:grid-cols-3">
              <div>
                <p className="mono tnum text-20 text-win">
                  {genOf(stats?.total_recovered_atto)} GEN
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-13 text-text-2">
                  <TrendingUp size={13} aria-hidden="true" />
                  Recovered from insurers
                </p>
              </div>
              <div>
                <p className="mono tnum text-20 text-loss">
                  {genOf(stats?.total_written_off_atto)} GEN
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-13 text-text-2">
                  <TrendingDown size={13} aria-hidden="true" />
                  Written off, openly
                </p>
              </div>
              <div>
                <p className="mono tnum text-20 text-text">{stats?.advance_count ?? '--'}</p>
                <p className="mt-1 text-13 text-text-2">Advances made</p>
              </div>
            </div>
          </Panel>

          <h2 className="display mt-14 text-31 text-text">The ledger</h2>
          <p className="mt-3 max-w-[42rem] text-16 text-text-2">
            Every movement of capital this pool has made. Wins and losses in the same table, because
            a pool that only shows you its wins is not telling you what it is.
          </p>

          {rows.length === 0 ? (
            <Panel className="mt-6 p-7">
              <p className="text-16 text-text">No advances yet.</p>
              <p className="mt-2 max-w-[36rem] text-14 text-text-2">
                The capital is in escrow and the terms are set. The first advance happens when a
                verdict clears the confidence band, which cannot be forced by anybody here.
              </p>
            </Panel>
          ) : (
            <div
              className="mt-6 overflow-x-auto border border-line"
              style={{ borderRadius: 'var(--radius-hair)' }}
            >
              <table className="w-full min-w-[44rem] border-collapse text-left">
                <thead>
                  <tr className="border-b border-line bg-raised">
                    {['Docket', 'Advanced', 'Band', 'Status', 'Recovered', 'When'].map((head) => (
                      <th key={head} className="mono px-4 py-3 text-12 font-normal text-text-3">
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr
                      key={row.docket}
                      className="seq stamp-in border-b border-line last:border-b-0"
                      style={{ ['--i' as string]: index }}
                    >
                      <td className="mono px-4 py-3.5 text-13 text-signal-bright">{row.docket}</td>
                      <td className="mono tnum px-4 py-3.5 text-13 text-text">
                        {genOf(row.amount_atto)} GEN
                      </td>
                      <td className="mono px-4 py-3.5 text-12 text-text-2">
                        {bandLabel(row.band)}
                      </td>
                      <td className="mono px-4 py-3.5 text-12">
                        <span
                          style={{
                            color:
                              row.status === 'RECOVERED'
                                ? 'var(--win)'
                                : row.status === 'WRITTEN_OFF'
                                  ? 'var(--loss)'
                                  : 'var(--wait)',
                          }}
                        >
                          {row.status.toLowerCase().replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="mono tnum px-4 py-3.5 text-13 text-text-2">
                        {row.recovered_atto === '0' ? '--' : `${genOf(row.recovered_atto)} GEN`}
                      </td>
                      <td className="mono px-4 py-3.5 text-12 text-text-3">
                        {row.made_at.slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="rail-aside flex flex-col gap-6">
          <RailNote index={1} title="Advance rate">
            {((config?.advance_rate_bps ?? 0) / 100).toFixed(0)}% of the amount in dispute, never
            all of it.
          </RailNote>
          <RailNote index={2} title="Recovery fee">
            {((config?.fee_bps ?? 0) / 100).toFixed(0)}% of the advance, taken only when the insurer
            actually pays.
          </RailNote>
          <RailNote index={3} title="Per band ceiling">
            A verdict in the top band cannot drain the pool on its own.{' '}
            {(config?.band_caps_atto ?? []).length} ceilings, one per payout band.
          </RailNote>
          <RailNote index={4} title="Utilisation ceiling">
            Some share of capital always stays free, so an underwriter can get out.
          </RailNote>
          <RailNote index={5} title="One advance per case">
            Enforced on both sides. The pool refuses, and the court refuses too.
          </RailNote>
        </div>
      </div>
    </section>
  );
}
