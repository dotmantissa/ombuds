import { z } from 'zod';

import { scrubText, extractCodes, bucketServiceDate } from '@/lib/deident';
import { ombudsCourtAddress, readContract } from '@/lib/genlayer';

export const dynamic = 'force-dynamic';

const Body = z.object({
  text: z.string().min(1).max(60000),
  serviceDate: z.string().optional(),
});

/**
 * The pre flight check.
 *
 * Runs the de-identification over a pasted letter and then asks the chain's own tripwire
 * whether what is left would be accepted. Nothing is stored and nothing is written. The
 * point is that a member finds out their letter still carries a member id while they can
 * still do something about it, rather than after a rejected transaction.
 */
export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return Response.json({ error: 'Send a JSON body with a text field.' }, { status: 400 });
  }

  const scrubbed = scrubText(parsed.text);
  const codes = extractCodes(scrubbed.clean);

  let chainFlags: string[] = [];
  let chainReachable = true;
  try {
    chainFlags = await readContract<string[]>({
      address: ombudsCourtAddress(),
      functionName: 'phi_scan',
      args: [scrubbed.clean.slice(0, 2000)],
    });
  } catch {
    chainReachable = false;
  }

  return Response.json({
    clean: scrubbed.clean,
    redactions: scrubbed.redactions,
    cptCodes: codes.cpt,
    icd10Codes: codes.icd10,
    serviceMonth: parsed.serviceDate ? bucketServiceDate(parsed.serviceDate) : null,
    chainFlags,
    chainReachable,
    accepted: chainReachable && chainFlags.length === 0,
  });
}
