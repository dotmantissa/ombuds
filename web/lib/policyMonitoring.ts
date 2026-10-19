import type { ChainRule } from './chainReads';
export function policyFlags(rule: ChainRule, today = new Date().toISOString().slice(0, 10)): string[] {
  if (rule.retired) return ['Retired'];
  const flags: string[] = [];
  const now = Date.parse(`${today}T00:00:00Z`);
  const expiry = Date.parse(`${rule.effective_to}T00:00:00Z`);
  if (expiry < now) flags.push('Expired');
  else if (expiry - now <= 30 * 86400_000) flags.push('Expires within 30 days');
  if (rule.effective_from > today) flags.push('Not yet effective');
  if (!rule.content_hash || !rule.last_refreshed) flags.push('Source not fingerprinted');
  else if (now - Date.parse(rule.last_refreshed) > 30 * 86400_000) flags.push('Source check over 30 days old');
  if (rule.revision_count > 0) flags.push('Source revisions recorded');
  return flags.length ? flags : ['Current'];
}
export function policyDifferences(before: Record<string, unknown>, after: Record<string, unknown>) {
  return ['bulletin_url', 'cms_source_url', 'effective_from', 'effective_to', 'clause_sections', 'content_hash', 'sbc_hash', 'retired']
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => ({ field, before: JSON.stringify(before[field] ?? ''), after: JSON.stringify(after[field] ?? '') }));
}
