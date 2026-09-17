/**
 * Bounded LRU record keyed by insertion order (plain objects preserve string
 * key insertion order in JS). Used for the reader image data map: hot entries
 * (visible thumbnails, current full-res) are evicted last.
 *
 * Pure and unit-tested; the React component wraps it in a version-guarded
 * functional state update.
 */
export function lruRecordPut(
  prev: Record<string, string>,
  key: string,
  value: string,
  limit: number,
): Record<string, string> {
  // Hit: promote to most-recently-used (no-op if already newest).
  if (prev[key] !== undefined) {
    const keys = Object.keys(prev);
    if (keys[keys.length - 1] === key) return prev;
    const promoted: Record<string, string> = {};
    for (const k of keys) {
      if (k !== key) promoted[k] = prev[k] as string;
    }
    promoted[key] = value;
    return promoted;
  }
  const keys = Object.keys(prev);
  if (keys.length < limit) return { ...prev, [key]: value };
  // Evict least-recently-used first.
  const next: Record<string, string> = {};
  const drop = keys.length - limit + 1;
  for (let i = drop; i < keys.length; i++) {
    const k = keys[i] as string;
    const v = prev[k];
    if (v !== undefined) next[k] = v;
  }
  next[key] = value;
  return next;
}

/** Remove keys; returns the original reference when nothing changed. */
export function lruRecordDelete(
  prev: Record<string, string>,
  keys: string[],
): Record<string, string> {
  if (!keys.some((k) => prev[k] !== undefined)) return prev;
  const next: Record<string, string> = {};
  for (const k of Object.keys(prev)) {
    if (!keys.includes(k)) next[k] = prev[k] as string;
  }
  return next;
}
