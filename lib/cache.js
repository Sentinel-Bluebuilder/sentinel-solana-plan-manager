// ─── Tiny TTL cache ──────────────────────────────────────────────────────────
// Small TTL cache for route reads. In-flight de-dupe:
// concurrent callers of the same key share one promise, so a burst of page
// loads never fans out into N identical getProgramAccounts calls.
const store = new Map(); // key -> { value, expires }
const inflight = new Map(); // key -> Promise

export async function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await fn();
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function cacheInvalidate(key) {
  store.delete(key);
}

/** Drop every key starting with `prefix`. */
export function cacheInvalidatePrefix(prefix) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

export function cacheClear() {
  store.clear();
}

export function cacheStats() {
  const now = Date.now();
  let live = 0;
  for (const v of store.values()) if (v.expires > now) live += 1;
  return { keys: store.size, live, inflight: inflight.size };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (v.expires <= now) store.delete(k);
}, 60_000).unref();
