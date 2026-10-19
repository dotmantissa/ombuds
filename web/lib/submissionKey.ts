/** Session-scoped retry keys contain no document text or authentication tokens. */
export function submissionKey(scope: string): string {
  const name = `ombuds:submission:${scope}`;
  let saved: string | null = null;
  try { saved = sessionStorage.getItem(name); } catch { /* Storage can be disabled. */ }
  if (saved) return saved;
  const key = crypto.randomUUID();
  try { sessionStorage.setItem(name, key); } catch { /* The server also deduplicates domain operations. */ }
  return key;
}
export function clearSubmissionKey(scope: string) {
  try { sessionStorage.removeItem(`ombuds:submission:${scope}`); } catch { /* No persisted key. */ }
}
