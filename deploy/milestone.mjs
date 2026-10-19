/** Immutable milestone deployment. Old contracts and capital are never modified. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chainClient, read, ROOT, RPC } from '../scripts/chain.mjs';
import { assertReceipt } from '../scripts/receipts.mjs';
const client = chainClient();
const statePath = path.join(ROOT, 'deploy', '.milestone-state.json');
const manifestPath = path.join(ROOT, 'deployed_contracts.json');
const files = ['plan_registry.py', 'ombuds_court.py', 'advance_pool.py'];
const sourceHashes = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'contracts', file))).digest('hex')]));
let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { sourceHashes, steps: {}, startedAt: new Date().toISOString() };
if (JSON.stringify(state.sourceHashes) !== JSON.stringify(sourceHashes)) throw new Error('Contract sources changed since this deployment started; preserve and inspect its state before creating a new deployment.');
function save() { fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(`${statePath}.tmp`, statePath); }
async function transaction(name, submit) {
  const step = state.steps[name];
  if (step?.done) return step;
  if (step && !step.hash) throw new Error(`${name} has an unknown submission outcome. Recover its hash from the network before resuming; no duplicate was sent.`);
  if (!step) {
    state.steps[name] = { phase: 'SUBMITTING' }; save();
    const hash = await submit();
    state.steps[name].hash = hash; state.steps[name].phase = 'PENDING'; save();
    console.log(`${name}: ${hash}`);
  }
  const hash = state.steps[name].hash;
  const receipt = await client.waitForTransactionReceipt({ hash, status: 'ACCEPTED', interval: 8000, retries: 200 });
  assertReceipt(receipt, name);
  const address = receipt.contract_address ?? receipt.contractAddress ?? receipt.data?.contract_address ?? receipt.to_address ?? receipt.to;
  state.steps[name] = { hash, ...(address ? { address } : {}), done: true, outcome: 'EXECUTED' }; save();
  return state.steps[name];
}
async function deploy(name, file, args) {
  const step = await transaction(name, () => client.deployContract({ code: fs.readFileSync(path.join(ROOT, 'contracts', file), 'utf8'), args }));
  if (!step.address) {
    const tx = await client.getTransaction({ hash: step.hash });
    step.address = tx.to_address ?? tx.to ?? tx.contract_address ?? tx.data?.contract_address;
    save();
  }
  if (!step.address) throw new Error(`No address found for ${name}; inspect ${step.hash}`);
  return step.address;
}
async function write(name, address, functionName, args, value = 0n) {
  return transaction(name, () => client.writeContract({ address, functionName, args, value }));
}
function patchEnv(file, addresses) {
  if (!fs.existsSync(file)) return;
  let text = fs.readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(addresses)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
}
try {
  console.log(`Milestone deployment signer: ${client.account.address}`);
  if (!state.previous) {
    state.previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const oldPool = state.previous.contracts.AdvancePool.address;
    state.previousPoolStats = await read(client, oldPool, 'pool_stats');
    save();
    fs.mkdirSync(path.join(ROOT, 'deployments'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'deployments', 'pre-milestone-f4ba79d.json'), `${JSON.stringify({ ...state.previous, archivedAt: new Date().toISOString(), poolStatsAtArchive: state.previousPoolStats, note: 'Legacy contracts remain accessible. Capital, outstanding advances and user positions were not migrated or withdrawn.' }, null, 2)}\n`);
  }
  const ATTO = 10n ** 18n;
  const registry = await deploy('registry', files[0], []);
  const court = await deploy('court', files[1], [registry, 70, String(ATTO / 4n)]);
  const caps = [ATTO / 4n, ATTO / 2n, ATTO, 2n * ATTO, 3n * ATTO, 4n * ATTO].map(String);
  const pool = await deploy('pool', files[2], [court, 3500, 1200, 7000, caps.join(',')]);
  await write('wire', court, 'set_pool', [pool]);
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/sources.json')));
  for (const rule of dataset.plan_rules) {
    await write(`register_${rule.plan_id}`, registry, 'register_rule', [rule.plan_id, rule.insurer, rule.plan_line, rule.family_id,
      rule.bulletin_number, rule.bulletin_title || `${rule.insurer} bulletin ${rule.bulletin_number}`, rule.bulletin_url, rule.fetch_mode,
      rule.state, rule.effective_from, rule.effective_to, rule.cms_source_url || '', rule.cms_display_id || '', rule.guideline_url || '', rule.clause_sections.join('|')]);
  }
  const [courtConfig, poolConfig, stats, registryStats] = await Promise.all([
    read(client, court, 'get_config'), read(client, pool, 'get_config'), read(client, pool, 'pool_stats'), read(client, registry, 'registry_stats'),
  ]);
  if (courtConfig.pool.toLowerCase() !== pool.toLowerCase() || courtConfig.registry.toLowerCase() !== registry.toLowerCase() || poolConfig.court.toLowerCase() !== court.toLowerCase()) throw new Error('Contract wiring failed verification.');
  if (registryStats.rule_count !== dataset.plan_rules.length) throw new Error('Registry seeding failed verification.');
  await read(client, registry, 'policy_history', [dataset.plan_rules[0].plan_id, 0, 1]);
  await read(client, pool, 'transaction_history', [0, 25, '', '']);
  await read(client, court, 'search_dockets', ['', '', '', '', 0, 25]);
  const manifest = { network: 'studionet', chainId: 61999, rpcUrl: RPC, deployer: client.account.address,
    deployedAt: new Date().toISOString(), milestone: 'reliability-provenance-appeals', sourceHashes,
    terms: { minConfidence: 70, reviewBondAtto: String(ATTO / 4n), advanceRateBps: 3500, feeBps: 1200, maxUtilisationBps: 7000, bandCapsAtto: caps },
    contracts: { PlanRegistry: { address: registry, txHash: state.steps.registry.hash }, OmbudsCourt: { address: court, txHash: state.steps.court.hash }, AdvancePool: { address: pool, txHash: state.steps.pool.hash } },
    verification: { checkedAt: new Date().toISOString(), registryStats, poolStats: stats, wiring: true, sourceFingerprints: 'New sources require refresh; monitoring shows unobserved until then.', nativeDelivery: 'Not established by contract execution; tracked separately.' },
    previousDeployment: 'deployments/pre-milestone-f4ba79d.json', note: 'Fresh immutable deployment. No legacy funds, cases or positions were migrated. Native payout delivery requires separate evidence.' };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const addresses = { PLAN_REGISTRY_ADDRESS: registry, OMBUDS_COURT_ADDRESS: court, ADVANCE_POOL_ADDRESS: pool };
  patchEnv(path.join(ROOT, '.env'), addresses); patchEnv(path.join(ROOT, 'web/.env.local'), addresses);
  state.published = true; save();
  console.log('All three contracts deployed, seeded and verified. Local addresses updated; legacy deployment archived.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
