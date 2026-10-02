/** Reads the three deployed contracts back and prints what the chain actually holds. */
import { chainClient, addresses, RPC } from './chain.mjs';

const c = chainClient();
const { registry, court, pool } = addresses();

console.log(`endpoint ${RPC}`);
console.log(`registry ${registry}`);
console.log(`court    ${court}`);
console.log(`pool     ${pool}\n`);

const rs = await c.readContract({ address: registry, functionName: 'registry_stats', args: [] });
console.log('registry_stats      ', JSON.stringify(rs));

const cc = await c.readContract({ address: court, functionName: 'get_config', args: [] });
console.log('court min_confidence', cc.min_confidence);
console.log('court knows registry', String(cc.registry).toLowerCase() === String(registry).toLowerCase());
console.log('court knows pool    ', String(cc.pool).toLowerCase() === String(pool).toLowerCase());
console.log('court grounds       ', JSON.stringify(cc.grounds));
console.log('court bands         ', JSON.stringify(cc.band_upper_usd));

const pc = await c.readContract({ address: pool, functionName: 'get_config', args: [] });
console.log('pool terms          ', `rate ${pc.advance_rate_bps}bps fee ${pc.fee_bps}bps util ${pc.max_utilisation_bps}bps caps ${pc.band_caps_atto.length}`);

const ps = await c.readContract({ address: pool, functionName: 'pool_stats', args: [] });
console.log('pool TVG atto       ', ps.total_value_governed_atto);

const dirty = 'Member ID X12345678 called us on 415-555-0199 about service on 03/14/2026';
const scan = await c.readContract({ address: court, functionName: 'phi_scan', args: [dirty] });
console.log('phi tripwire        ', JSON.stringify(scan));
