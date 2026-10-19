import { z } from 'zod';
import { requireMember, authErrorResponse } from '@/lib/privy';
import { planRegistryAddress, readContract, ReceiptTimeoutError } from '@/lib/genlayer';
import { trackedWrite, existingOperationResponse } from '@/lib/operations';
export const dynamic = 'force-dynamic'; export const maxDuration = 300;
const Body = z.object({ planId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), action: z.enum(['refresh', 'extend', 'retire']),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export async function POST(req: Request) {
  let member; try { member = await requireMember(req); } catch (e) { return authErrorResponse(e); }
  let body; try { body = Body.parse(await req.json()); } catch { return Response.json({ error: 'Choose a policy, action and valid expiry when extending.' }, { status: 400 }); }
  try {
    const registry = planRegistryAddress();
    if (!member.memberAddress || !(await readContract<boolean>({ address: registry, functionName: 'is_curator', args: [member.memberAddress] }))) {
      return Response.json({ error: 'Only a verified registry curator may maintain policies.' }, { status: 403 });
    }
    if (body.action === 'extend' && !body.effectiveTo) return Response.json({ error: 'A new expiration date is required.' }, { status: 400 });
    const rule = await readContract<{ policy_version: number }>({ address: registry, functionName: 'rule_for', args: [body.planId] });
    const write = await trackedWrite(member.id, req.headers.get('idempotency-key') ?? `policy_${body.planId}_${body.action}_${rule.policy_version}`,
      { address: registry, functionName: { refresh: 'refresh_rule', extend: 'extend_rule', retire: 'retire_rule' }[body.action],
        args: body.action === 'extend' ? [body.planId, body.effectiveTo!] : [body.planId] });
    if (!write.ok) return Response.json({ error: 'Policy maintenance was rejected by the registry.', txHash: write.txHash }, { status: 422 });
    return Response.json({ txHash: write.txHash, status: write.status });
  } catch (e) { const existing = existingOperationResponse(e); if (existing) return existing;
    if (e instanceof ReceiptTimeoutError) return Response.json({ pending: true, txHash: e.txHash }, { status: 202 });
    return Response.json({ error: 'Policy maintenance could not be confirmed. Check transaction history before retrying.' }, { status: 502 }); }
}
