'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi } from '@/lib/useApi';
import { submissionKey } from '@/lib/submissionKey';
export function PolicyActions({ planId, version }: { planId: string; version: number }) {
  const { call, authenticated } = useApi(); const router = useRouter();
  const [curator, setCurator] = useState(false); const [busy, setBusy] = useState(false);
  const [date, setDate] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => { let active = true;
    if (authenticated) void call<{ curator: boolean }>('/api/policies/access').then((r) => { if (active) setCurator(r.curator); }).catch(() => undefined);
    return () => { active = false; };
  }, [authenticated, call]);
  async function run(action: 'refresh' | 'extend' | 'retire') {
    setBusy(true); setMessage('Submitting policy maintenance…');
    try {
      const r = await call<{ pending?: boolean; txHash?: string }>('/api/policies', { method: 'POST',
        headers: { 'idempotency-key': submissionKey(`policy:${planId}:${version}:${action}:${date}`) },
        body: JSON.stringify({ planId, action, effectiveTo: date || undefined }) });
      setMessage(r.pending ? 'Maintenance is pending. Its receipt is in your transaction history.' : 'Policy maintenance recorded. Refreshing the registry view.'); router.refresh();
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Maintenance could not be confirmed.'); }
    finally { setBusy(false); }
  }
  if (!authenticated || !curator) return <p className="mt-5 text-13 text-text-3">Maintenance actions are available to verified registry curators. Policy history is public.</p>;
  return <div className="mt-5 border-t border-line pt-4"><h3 className="text-16">Curator maintenance</h3><div className="mt-3 flex flex-wrap items-center gap-3">
    <button disabled={busy} onClick={() => void run('refresh')} className="border border-line px-4 py-2 text-14">Check published source</button>
    <label className="text-13">New expiry <input aria-label="New policy expiration date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="ml-2 border border-line bg-raised p-2" /></label>
    <button disabled={busy || !date} onClick={() => void run('extend')} className="border border-line px-4 py-2 text-14">Extend registration</button>
    <button disabled={busy} onClick={() => void run('retire')} className="border border-line px-4 py-2 text-14 text-loss">Retire policy</button>
  </div>{message && <p role="status" className="mt-3 text-13">{message}</p>}</div>;
}
