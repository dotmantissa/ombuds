'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import { Panel, Stat, StatusChip } from '@/components/ui/primitives';
import { FinancialHistory } from './FinancialHistory';
import { formatGen, type Page, type Payout, type ProtocolEvent } from '@/lib/protocol';
import type { PoolPosition } from '@/lib/chainReads';
interface Activity {
  wallet: string | null; position: (PoolPosition & { reserved_atto: string; entitlement_atto: string }) | null;
  history: Page<ProtocolEvent> | null; payouts: Page<Payout> | null; claimable: string | null; bond: string | null;
  cases: Array<{ docket: string; status: string; plan_id: string; filed_at: string }>; caseTotal: number; unavailable: boolean;
  operations: Page<{ id: string; method: string; status: string; tx_hash: string | null; docket: string | null; created_at: string }>;
}
export function AccountDashboard({ poolOnly = false }: { poolOnly?: boolean }) {
  const { call, authenticated } = useApi();
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState(''); const [offset, setOffset] = useState(0); const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    void call<Activity>(`/api/activity?offset=${offset}`).then((value) => { if (active) { setData(value); setError(''); } })
      .catch(() => { if (active) setError('Activity could not be loaded. Refresh to try again.'); });
    return () => { active = false; };
  }, [authenticated, call, offset, refresh]);
  if (!authenticated) return <Panel className="mt-8 p-6"><p className="text-16">Sign in to see your cases, underwriting position and transaction history.</p></Panel>;
  const p = data?.position;
  return <div className="mt-8 space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="display text-26">{poolOnly ? 'Your underwriting position' : 'Your activity'}</h2><button onClick={() => setRefresh((n) => n + 1)} className="border border-line px-4 py-2 text-14">Refresh from chain</button></div>
    {error && <p role="alert" className="text-loss">{error}</p>}
    {!data ? <p role="status" className="text-14 text-text-2">Reading your records…</p> : <>
      {data.unavailable && <p className="text-14 text-wait">Some chain records could not be read. Displayed figures may be incomplete; refresh before acting.</p>}
      <Panel className="p-6"><p className="mono break-all text-12 text-text-3">{data.wallet ?? 'Your account does not have a wallet address yet.'}</p>
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Stat value={formatGen(p?.principal_atto)} caption="Total deposited" /><Stat value={formatGen(p?.fees_earned_atto)} caption="Fees earned" tone="win" />
          <Stat value={formatGen(p?.loss_borne_atto)} caption="Losses borne" tone="loss" /><Stat value={formatGen(p?.withdrawn_atto)} caption="Withdrawals submitted" />
          <Stat value={formatGen(p?.withdrawable_atto)} caption="Available to withdraw" /><Stat value={formatGen(p?.reserved_atto)} caption="Reserved against advances" tone="wait" />
        </div><p className="mt-5 text-13 text-text-2">Withdrawals are limited by your remaining equity, capital reserved for advances you underwrote, and free pool cash. Reserved capital stays unavailable until settlement or write-off.</p>
        <p className="mt-3 text-13">Recovery surplus available: {formatGen(data.claimable ?? undefined)} · Returned appeal bonds: {formatGen(data.bond ?? undefined)}</p>
      </Panel>
      {!poolOnly && <Panel className="p-6"><h2 className="display text-26">Your cases</h2><input aria-label="Filter your cases on this page" placeholder="Filter this page by docket or plan" value={filter} onChange={(e) => setFilter(e.target.value)} className="mt-4 w-full border border-line bg-raised p-3 text-14" />
        <ul className="mt-4 divide-y divide-line">{data.cases.filter((c) => `${c.docket} ${c.plan_id}`.toLowerCase().includes(filter.toLowerCase())).map((c) => <li key={c.docket} className="flex flex-wrap items-center justify-between gap-3 py-4"><Link href={`/case/${c.docket}`} className="text-signal-bright hover:underline">{c.docket}<span className="mt-1 block text-12 text-text-3">{c.plan_id}</span></Link><StatusChip status={c.status} /></li>)}</ul>
        {data.cases.length === 0 && <p className="mt-4 text-14 text-text-3">No cases on this page. <Link href="/file" className="text-signal-bright">File a case</Link></p>}
      </Panel>}
      <Panel className="p-6"><FinancialHistory history={data.history} payouts={data.payouts} /></Panel>
      <Panel className="p-6"><h3 className="text-18">Submitted transactions</h3><p className="mt-2 text-13 text-text-2">Executed means the contract ran successfully. It does not confirm payment delivery. Unknown submissions stay blocked until reconciled; do not submit a replacement payment.</p>
        <ul className="mt-4 divide-y divide-line">{data.operations.items.map((o) => <li className="py-4 text-13" key={o.id}><p className="flex flex-wrap justify-between gap-2"><span>{o.method.replaceAll('_', ' ')} {o.docket && <Link className="text-signal-bright" href={`/case/${o.docket}`}>{o.docket}</Link>}</span><strong className="font-normal">{o.status}</strong></p>{o.tx_hash ? <a href={`https://explorer-studio.genlayer.com/tx/${o.tx_hash}`} target="_blank" rel="noreferrer" className="mono mt-2 block break-all text-12 text-signal-bright">{o.tx_hash}</a> : <p className="mt-2 text-wait">No hash recorded. Reconciliation is required before another submission.</p>}</li>)}</ul>
        {data.operations.total === 0 && <p className="mt-4 text-14 text-text-3">No submitted transactions recorded yet.</p>}
      </Panel>
      <div className="flex items-center justify-between gap-3 text-14"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))} className="border border-line px-4 py-2 disabled:opacity-40">Previous</button><span>Page {offset / 25 + 1}</span><button disabled={Math.max(data.caseTotal, data.history?.total ?? 0, data.payouts?.total ?? 0, data.operations.total) <= offset + 25} onClick={() => setOffset(offset + 25)} className="border border-line px-4 py-2 disabled:opacity-40">Next</button></div>
    </>}
  </div>;
}
