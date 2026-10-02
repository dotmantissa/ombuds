/**
 * deploy/seed_registry.mjs
 *
 * Registers every verified plan rule from data/sources.json into PlanRegistry on chain,
 * then optionally asks the registry to refresh each one so the first content digest is
 * recorded.
 *
 * The refresh step is the interesting one. It runs under strict_eq, so every validator
 * re-fetches the bulletin from its own network and they all have to arrive at the same
 * normalised digest. Pass --no-refresh to register without that.
 */

import { chainClient, addresses, send, ROOT } from '../scripts/chain.mjs';
import fs from 'node:fs';
import path from 'node:path';

const skipRefresh = process.argv.includes('--no-refresh');
const onlyRefresh = process.argv.includes('--refresh-only');

const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'sources.json'), 'utf8'));
const client = chainClient();
const { registry } = addresses();

if (!registry) {
  console.error('PLAN_REGISTRY_ADDRESS is missing from .env. Deploy first.');
  process.exit(1);
}

console.log(`registry ${registry}`);
console.log(`rules    ${sources.plan_rules.length}\n`);

const registered = [];

for (const rule of sources.plan_rules) {
  if (!onlyRefresh) {
    await send(
      client,
      registry,
      'register_rule',
      [
        rule.plan_id,
        rule.insurer,
        rule.plan_line,
        rule.family_id,
        rule.bulletin_number,
        rule.bulletin_title || `${rule.insurer} bulletin ${rule.bulletin_number}`,
        rule.bulletin_url,
        rule.fetch_mode,
        rule.state,
        rule.effective_from,
        rule.effective_to,
        rule.cms_source_url || '',
        rule.cms_display_id || '',
        rule.guideline_url || '',
        (rule.clause_sections || []).join('|'),
      ],
      `register ${rule.plan_id}`,
    );
  }
  registered.push(rule);
}

if (!skipRefresh) {
  console.log('\nRefreshing each rule so the first content digest lands on chain.');
  console.log('Every validator re-fetches the bulletin for this, so it can take a while.\n');
  for (const rule of registered) {
    try {
      await send(client, registry, 'refresh_rule', [rule.plan_id], `refresh ${rule.plan_id}`);
    } catch (err) {
      // A source that is rate limiting the validators is worth reporting, not worth
      // failing the whole seed over. The rule is registered either way and a refresh can
      // be retried at any time.
      console.log(`  skipped ${rule.plan_id}: ${err?.message || err}`);
    }
  }
}

const stats = await client.readContract({
  address: registry,
  functionName: 'registry_stats',
  args: [],
});
console.log('\nregistry_stats', JSON.stringify(stats));

for (const rule of registered) {
  const row = await client.readContract({
    address: registry,
    functionName: 'rule_for',
    args: [rule.plan_id],
  });
  const digest = row.content_hash ? `${row.content_hash.slice(0, 12)}...` : 'not refreshed yet';
  console.log(
    `  ${row.plan_id.padEnd(40)} active=${row.active}  sections=${row.clause_sections.length}  digest=${digest}`,
  );
}
