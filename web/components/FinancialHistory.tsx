import Link from 'next/link';
import type { Page, Payout, ProtocolEvent } from '@/lib/protocol';
import { formatGen, PAYMENT_LABELS } from '@/lib/protocol';
export function FinancialHistory({ history, payouts }: { history: Page<ProtocolEvent> | null; payouts: Page<Payout> | null }) {
  return <div className="space-y-6">
    <div><h3 className="text-18 text-text">Financial activity</h3>
      {history === null ? <p className="mt-3 text-14 text-wait">Transaction history is unavailable.</p> : history.items.length === 0 ? <p className="mt-3 text-14 text-text-3">No activity in this view.</p> :
      <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-13"><thead><tr className="border-b border-line">{['When', 'Activity', 'Amount', 'Case / reference'].map((h) => <th className="p-3 font-normal text-text-3" key={h}>{h}</th>)}</tr></thead><tbody>
        {history.items.map((e) => <tr key={e.id} className="border-b border-line"><td className="p-3 whitespace-nowrap">{e.at.slice(0, 19).replace('T', ' ')}</td><td className="p-3">{e.kind.replaceAll('_', ' ')}</td><td className="mono p-3 whitespace-nowrap" title={`${e.amount_atto} atto`}>{formatGen(e.amount_atto)}</td><td className="p-3">{e.docket ? <Link className="text-signal-bright hover:underline" href={`/case/${e.docket}`}>{e.docket}</Link> : e.reference || '—'}</td></tr>)}
      </tbody></table><p className="mt-2 text-12 text-text-3">{history.total} recorded events in this view.</p></div>}
    </div>
    <div><h3 className="text-18 text-text">Payment delivery</h3><p className="mt-2 text-13 text-text-2">Execution and delivery are tracked separately. Pending payments stay unverified until the recipient acknowledges receipt. A retry requires the full amount to have been returned.</p>
      {payouts === null ? <p className="mt-3 text-14 text-wait">Payment records are unavailable.</p> : payouts.items.length === 0 ? <p className="mt-3 text-14 text-text-3">No outgoing payments in this view.</p> : <ul className="mt-4 space-y-3">{payouts.items.map((p) => <li key={p.id} className="border border-line p-4 text-13"><p className="flex flex-wrap justify-between gap-2"><span>{p.kind.replaceAll('_', ' ')} · {formatGen(p.amount_atto)}</span><strong className="font-normal text-wait">{PAYMENT_LABELS[p.status] ?? p.status}</strong></p><p className="mono mt-2 break-all text-12 text-text-3">Payment {p.id} · attempt {p.attempt} · to {p.recipient}</p>{p.docket && <Link className="mt-2 inline-block text-signal-bright" href={`/case/${p.docket}`}>{p.docket}</Link>}</li>)}</ul>}
    </div>
  </div>;
}
