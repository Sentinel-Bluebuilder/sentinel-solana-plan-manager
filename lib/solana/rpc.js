// ─── RPC pool with self-healing failover ─────────────────────────────────────
// rpcCall() over @solana/web3.js Connections. Every server-side RPC read goes through rpcCall();
// nothing holds a Connection across calls, so a dead or rate-limited endpoint
// is benched for 60 s and the next call lands elsewhere with no restart.
//
// dvpnctl/dvpnd never retry a 429 (docs/19 "RPC 429 handling ❌"); here a 429
// benches the endpoint and retries, so one throttled read never fails a page.
//
// RPC rate-limit rules: at most RPC_MAX_RPS (default 5)
// calls per second per process, exponential 429 back-off per endpoint (1 s → 30 s)
// that moves the call to the next endpoint (public devnet last), and a request /
// 429 count every run reports (getRpcCounters, /health/rpc).
import { Connection } from '@solana/web3.js';

const COOLDOWN_MS = 60_000;
const QUERY_TIMEOUT_MS = 12_000;
const COMMITMENT = 'confirmed';

const urls = (process.env.SOLANA_RPC_URLS || 'https://api.devnet.solana.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!urls.length) throw new Error('SOLANA_RPC_URLS is empty');

const benched = new Map(); // url -> until (ms)
const connections = new Map(); // url -> Connection
let lastServing = urls[0];
let lastSlot = null;
let lastLatencyMs = null;

function connectionFor(url) {
  let c = connections.get(url);
  if (!c) {
    c = new Connection(url, {
      commitment: COMMITMENT,
      disableRetryOnRateLimit: true, // we bench + rotate instead of web3's in-place sleep/retry
      confirmTransactionInitialTimeout: 60_000,
    });
    connections.set(url, c);
  }
  return c;
}

/** Candidate endpoints in priority order, benched ones last (never empty). */
export function rpcCandidates() {
  const now = Date.now();
  const live = urls.filter((u) => !(benched.get(u) > now));
  const cold = urls.filter((u) => benched.get(u) > now);
  return live.length ? [...live, ...cold] : [...urls];
}

const RATE_LIMIT_BASE_MS = 1_000;
const RATE_LIMIT_MAX_MS = 30_000;
const MIN_GAP_MS = Math.ceil(1000 / Math.max(1, Number(process.env.RPC_MAX_RPS) || 5));

// ─── Per-process pacing + counters ───────────────────────────────────────────
const counters = { requests: 0, rateLimited: 0, transportErrors: 0, startedAt: Date.now() };
const byLabel = new Map(); // label -> calls sent, so a key drain can be traced to the reader that caused it
const backoffLevel = new Map(); // url -> consecutive 429s
let nextSlotAt = 0;
async function pace() {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}
export function getRpcCounters() {
  const top = [...byLabel].sort((a, b) => b[1] - a[1]).slice(0, 20);
  return { ...counters, seconds: Math.round((Date.now() - counters.startedAt) / 1000), maxRps: Math.round(1000 / MIN_GAP_MS), byLabel: Object.fromEntries(top) };
}

/** One log line with the totals and the busiest readers. Never touches the network. */
export function logRpcCounters(reason) {
  const c = getRpcCounters();
  const top = Object.entries(c.byLabel).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[rpc] ${reason}: ${c.requests} calls in ${c.seconds}s (429s ${c.rateLimited}, transport errors ${c.transportErrors})${top ? ` · ${top}` : ''}`);
}

// Hourly line in the log, so the call count survives a crash or a kill. Only reads counters.
setInterval(() => { if (counters.requests) logRpcCounters('hourly'); }, 3_600_000).unref();

export function benchEndpoint(url, reason, ms = COOLDOWN_MS) {
  benched.set(url, Date.now() + ms);
  console.warn(`[rpc] benched ${redactUrl(url)} for ${ms / 1000}s: ${reason}`);
}

export function isRateLimited(err) {
  return /429|Too Many Requests|rate limit/i.test(String(err?.message || err || ''));
}

export function isTransportError(err) {
  // A rejected send carries program logs ("consumed 15029 of 200000 compute units") that can
  // contain 429/502/503/504 by accident: the node answered, so it is never a transport failure.
  if (err && typeof err === 'object' && (err.transactionMessage !== undefined || err.transactionLogs !== undefined || err.name === 'SendTransactionError')) return false;
  const m = String(err?.message || err || '').split('\n')[0];
  return /\b(429|502|503|504)\b|Too Many Requests|rate limit|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|timed out|timeout|Gateway|network error|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(m);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run `fn(connection)` against the pool. Transport failures bench the endpoint
 * and retry on the next one; chain-level errors propagate immediately (they are
 * real answers from a healthy node). `fallback` (if given) is returned instead of
 * throwing once every attempt failed.
 */
export async function rpcCall(fn, { label = 'rpc', attempts = 3, timeoutMs = QUERY_TIMEOUT_MS, fallback } = {}) {
  const errors = [];
  const tried = new Set();
  for (let i = 0; i < attempts; i++) {
    // Live endpoints first, and never the same host twice while an untried one remains.
    const candidates = rpcCandidates();
    const url = candidates.find((u) => !tried.has(u)) || candidates[0];
    tried.add(url);
    // Every endpoint benched (or a one-endpoint pool): wait a little instead of
    // burning the whole attempt budget in a few milliseconds against the same host.
    const until = benched.get(url) || 0;
    if (until > Date.now()) await sleep(Math.min(until - Date.now(), 2000 * (i + 1)));
    await pace();
    counters.requests++;
    byLabel.set(label, (byLabel.get(label) || 0) + 1);
    const started = Date.now();
    try {
      const out = await withTimeout(fn(connectionFor(url), url), timeoutMs, label);
      backoffLevel.delete(url);
      lastServing = url;
      lastLatencyMs = Date.now() - started;
      return out;
    } catch (err) {
      if (!isTransportError(err)) throw err;
      errors.push(`${redactUrl(url)}: ${err.message.split('\n')[0].slice(0, 160)}`);
      if (isRateLimited(err)) {
        counters.rateLimited++;
        const level = (backoffLevel.get(url) || 0) + 1;
        backoffLevel.set(url, level);
        benchEndpoint(url, `${label}: 429`, Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** (level - 1)));
      } else {
        counters.transportErrors++;
        benchEndpoint(url, `${label}: ${err.message.slice(0, 120)}`, COOLDOWN_MS);
      }
    }
  }
  if (fallback !== undefined) {
    console.error(`[rpc] ${label} failed on every endpoint, using fallback:\n  ${errors.join('\n  ')}`);
    return fallback;
  }
  throw new Error(`${label}: all RPC endpoints failed:\n  ${errors.join('\n  ')}`);
}

/** The Connection currently preferred for sends (same pool, same benching). */
export function sendConnection() {
  return connectionFor(rpcCandidates()[0]);
}

/** Hide API keys carried in query strings / paths before a URL leaves the server. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.search) u.search = '?<redacted>';
    const parts = u.pathname.split('/');
    u.pathname = parts.map((p) => (p.length >= 20 && /^[A-Za-z0-9_-]+$/.test(p) ? '<redacted>' : p)).join('/');
    return u.toString();
  } catch (err) {
    return '<unparseable url>';
  }
}

export async function getRpcState() {
  const now = Date.now();
  let slot = lastSlot;
  try {
    slot = await rpcCall((c) => c.getSlot(COMMITMENT), { label: 'health:slot', attempts: 2, timeoutMs: 6000 });
    lastSlot = slot;
  } catch (err) {
    console.warn(`[rpc] health slot read failed: ${err.message}`);
  }
  return {
    serving: redactUrl(lastServing),
    slot,
    latencyMs: lastLatencyMs,
    commitment: COMMITMENT,
    pool: urls.map(redactUrl),
    counters: getRpcCounters(),
    benched: urls.filter((u) => benched.get(u) > now).map((u) => ({ url: redactUrl(u), untilMs: benched.get(u) - now })),
  };
}

export { COMMITMENT };
