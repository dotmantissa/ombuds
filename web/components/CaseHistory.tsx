import Link from 'next/link';
import { Panel } from '@/components/ui/primitives';
import { caseHistory, verdictHistory } from '@/lib/chainReads';
import { verdictChanges, formatGen } from '@/lib/protocol';
function eventLabel(kind: string) { return ({ FILED: 'Case filed', ADJUDICATED: 'Panel verdict recorded',
  EVIDENCE_UPDATED: 'Evidence amended', APPEAL_OPENED: 'Appeal submitted and bond posted',
  APPEAL_RESOLVED: 'Appeal decided', APPEAL_ABANDONED: 'Appeal abandoned before review',
  BOND_RETURNED: 'Bond made claimable', BOND_FORFEITED: 'Bond forfeited to court',
  ADVANCE_RECORDED: 'Advance recorded; delivery tracked separately', SETTLED: 'Case financially settled', REJECTED: 'Case rejected',
} as Record<string, string>)[kind] ?? kind.replaceAll('_', ' '); }
export async function CaseHistory({ docket, eventOffset = 0, verdictOffset = 0 }: { docket: string; eventOffset?: number; verdictOffset?: number }) {
  const [events, history] = await Promise.all([caseHistory(docket, eventOffset), verdictHistory(docket, verdictOffset)]);
  const first = history?.items[0]; const latest = history?.items.at(-1);
  const changes = first && latest && first !== latest ? verdictChanges(first, latest) : [];
  return <div className="mt-10 space-y-7">
    <Panel className="p-6"><h2 className="display text-26">Case and appeal timeline</h2>
      {events === null ? <p className="mt-4 text-14 text-wait">The timeline could not be read from the contract. Refresh to try again.</p> : <ol className="mt-5 border-l border-line pl-5">{events.items.map((e) => <li className="relative pb-6" key={e.sequence}><span className="absolute -left-[1.55rem] top-1 h-2 w-2 rounded-full bg-signal" /><p className="mono text-12 text-text-3">{e.at.slice(0, 19).replace('T', ' ')} UTC</p><h3 className="mt-1 text-16">{eventLabel(e.kind)}</h3><div className="mt-2 space-y-1 text-13 text-text-2">
        {e.details?.round != null && <p>Review round {String(e.details.round)} · fresh panel requested</p>}
        {e.details?.bond_atto != null && <p>Bond: {formatGen(String(e.details.bond_atto))}</p>}
        {e.details?.sponsor != null && <p className="break-all">Bond funded by {String(e.details.sponsor)}. Returned bonds belong to this sponsor.</p>}
        {e.details?.verdict_changed != null && <p>{e.details.verdict_changed ? 'The ruling changed.' : 'The ruling did not change.'} {e.details.bond_returned ? 'The bond was returned.' : 'The bond was forfeited.'}</p>}
        {e.details?.amount_atto != null && <p>{formatGen(String(e.details.amount_atto))}</p>}
        {e.details?.reason != null && <p>{String(e.details.reason)}</p>}
        {e.details?.from_hash != null && <p className="break-all">Evidence changed from {String(e.details.from_hash)} to {String(e.details.to_hash)}.</p>}
      </div></li>)}</ol>}
      {events && <div className="flex justify-between text-13">{eventOffset > 0 ? <Link href={`?events=${Math.max(0, eventOffset - 25)}&verdicts=${verdictOffset}`} className="text-signal-bright">Earlier events</Link> : <span />}{eventOffset + 25 < events.total && <Link href={`?events=${eventOffset + 25}&verdicts=${verdictOffset}`} className="text-signal-bright">Later events</Link>}</div>}
    </Panel>
    <Panel className="p-6"><h2 className="display text-26">Evidence explorer</h2><p className="mt-3 text-14 text-text-2">Each panel round preserves its policy version, source fingerprints, submitted evidence commitment and cited clause. The original document stays private; these hashes let its holder verify it later.</p>
      {history === null ? <p className="mt-4 text-14 text-wait">Evidence history is unavailable.</p> : history.items.length === 0 ? <p className="mt-4 text-14 text-text-3">Evidence will be linked here when a panel rules.</p> : <>
        {first && latest && first !== latest && <div className="mt-6"><h3 className="text-18">{verdictOffset === 0 ? 'Original verdict compared with the latest round on this page' : 'Changes between rounds on this page'}</h3><p className="mt-2 text-13 text-text-2">{first.ruling_digest === latest.ruling_digest ? 'The decision stayed the same.' : 'The decision changed.'} {changes.length === 0 ? 'No tracked fields changed.' : 'Changes are listed below.'}</p>
          {changes.length > 0 && <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-13"><thead><tr>{['Field', `Round ${first.panel_round}`, `Round ${latest.panel_round}`].map((h) => <th className="border-b border-line p-3 font-normal" key={h}>{h}</th>)}</tr></thead><tbody>{changes.map((c) => <tr key={c.label}><th className="border-b border-line p-3 font-normal">{c.label}</th><td className="max-w-48 break-all border-b border-line p-3">{c.before}</td><td className="max-w-48 break-all border-b border-line p-3">{c.after}</td></tr>)}</tbody></table></div>}
        </div>}
        <div className="mt-6 space-y-4">{history.items.map((v) => <details key={v.digest} className="border border-line p-4" open={v === latest}><summary className="cursor-pointer text-16">Round {v.panel_round} · {v.overturn_recommended ? 'Overturn recommended' : 'Denial upheld'} · policy version {v.provenance?.policy?.policy_version ?? 'unversioned'}</summary><p className="mt-4 text-14">{v.reasoning}</p><h3 className="mt-4 text-14">{v.clause_id} · {v.clause_section}</h3><blockquote className="mt-3 border-l-2 border-signal pl-4 text-14 text-text-2">{v.clause_quote}</blockquote>
          <ul className="mt-4 space-y-2">{v.citations.filter((c) => c.url?.startsWith('https://')).map((c, i) => <li className="text-13" key={i}><a href={c.url} target="_blank" rel="noreferrer" className="break-all text-signal-bright hover:underline">{c.title ?? c.url}</a>{c.locator && <span> · {c.locator}</span>}</li>)}</ul>
          <dl className="mono mt-4 space-y-3 break-all text-12 text-text-3">{Object.entries({ 'Verdict digest': v.digest, 'Ruling digest': v.ruling_digest, 'Evidence commitment': v.provenance?.evidence_sha256,
            'Sanitized record digest': v.provenance?.record_sha256, 'Provenance digest': v.provenance?.sha256, 'Policy configuration digest': v.provenance?.policy?.policy_digest,
            'Bulletin digest': v.bulletin_digest, 'CMS digest': v.cms_digest }).map(([k, val]) => <div key={k}><dt>{k}</dt><dd className="mt-1">{val || 'Not recorded'}</dd></div>)}</dl>
          <p className="mt-4 text-13">Policy effective {v.provenance?.policy?.effective_from} to {v.provenance?.policy?.effective_to}. <Link href={`/policies?plan=${encodeURIComponent(v.provenance?.policy?.plan_id ?? '')}`} className="text-signal-bright">Inspect policy history</Link></p>
        </details>)}</div>
        <div className="mt-4 flex justify-between text-13">{verdictOffset > 0 ? <Link href={`?events=${eventOffset}&verdicts=${Math.max(0, verdictOffset - 25)}`} className="text-signal-bright">Earlier verdicts</Link> : <span />}{verdictOffset + 25 < history.total && <Link href={`?events=${eventOffset}&verdicts=${verdictOffset + 25}`} className="text-signal-bright">Later verdicts</Link>}</div>
      </>}
    </Panel>
  </div>;
}
