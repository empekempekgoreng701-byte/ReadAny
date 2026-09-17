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

/**
 * Enforce a total byte budget (LRU order: drops oldest first). `sizeOf`
 * measures one entry (e.g. base64 string length). Returns the original
 * reference when already within budget. This is the real OOM guard: entry
 * counts alone cannot bound memory when values are ~1MB base64 images.
 */
export function enforceByteLimit(
  map: Record<string, string>,
  maxBytes: number,
  sizeOf: (value: string) => number = (value) => value.length,
): Record<string, string> {
  const keys = Object.keys(map);
  let total = 0;
  for (const key of keys) {
    total += sizeOf(map[key] as string);
    if (total > maxBytes) break;
  }
  if (total <= maxBytes) return map;
  let running = 0;
  for (const key of keys) running += sizeOf(map[key] as string);
  const next: Record<string, string> = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    const size = sizeOf(map[key] as string);
    // Always keep the newest entry (currently viewed image); the budget is
    // best-effort, never a reason to lose what is on screen.
    if (running <= maxBytes || i === keys.length - 1) {
      next[key] = map[key] as string;
    } else {
      running -= size;
    }
  }
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
