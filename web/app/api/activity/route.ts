import { requireMember, authErrorResponse } from '@/lib/privy';
import { listCasesForMember, countCasesForMember } from '@/lib/db';
import { memberOperations } from '@/lib/reconciliation';
import { caseOnChain, poolTransactions, poolPayouts, underwriterPosition, searchDockets } from '@/lib/chainReads';
import { pageNumber } from '@/lib/protocol';
import { advancePoolAddress, ombudsCourtAddress, readContract } from '@/lib/genlayer';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  let member;
  try { member = await requireMember(req); } catch (err) { return authErrorResponse(err); }
  try {
    const offset = pageNumber(new URL(req.url).searchParams.get('offset'));
    const operations = await memberOperations(member.id, offset);
    const indexed = await listCasesForMember(member.id, 25, offset);
    const indexedTotal = await countCasesForMember(member.id);
    const wallet = member.memberAddress;
    const [ownChain, position, history, payouts, claimable, bond] = await Promise.all([
      wallet ? searchDockets('', '', '', wallet, offset, 25) : null,
      wallet ? underwriterPosition(wallet) : null,
      wallet ? poolTransactions(offset, 25, wallet) : null,
      wallet ? poolPayouts(offset, 25, wallet) : null,
      wallet ? readContract<string>({ address: advancePoolAddress(), functionName: 'claimable_of', args: [wallet] }).catch(() => null) : null,
      wallet ? readContract<string>({ address: ombudsCourtAddress(), functionName: 'bond_of', args: [wallet] }).catch(() => null) : null,
    ]);
    const cases = await Promise.all(indexed.map((c) => caseOnChain(c.docket)));
    const unique = new Map<string, Record<string, unknown>>();
    for (const row of [...(ownChain?.items ?? []), ...cases.filter((c) => c !== null)]) unique.set(String(row.docket), { ...row });
    return Response.json({ source: 'chain', wallet, position, history, payouts, claimable, bond,
      cases: [...unique.values()], caseTotal: Math.max(indexedTotal, ownChain?.total ?? 0), operations, offset,
      unavailable: cases.some((c) => c === null) || (wallet !== null && position === null) });
  } catch {
    return Response.json({ error: 'Your activity could not be loaded. Refresh to try reading it again.' }, { status: 502 });
  }
}
