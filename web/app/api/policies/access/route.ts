import { requireMember, authErrorResponse } from '@/lib/privy';
import { planRegistryAddress, readContract } from '@/lib/genlayer';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  try { const member = await requireMember(req);
    const curator = member.memberAddress ? await readContract<boolean>({ address: planRegistryAddress(), functionName: 'is_curator', args: [member.memberAddress] }) : false;
    return Response.json({ curator });
  } catch (error) { return authErrorResponse(error); }
}
