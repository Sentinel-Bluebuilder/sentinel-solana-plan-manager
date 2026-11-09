// ─── Route helpers ───────────────────────────────────────────────────────────
import { PublicKey } from '@solana/web3.js';
import { sendError } from './errors.js';
import { currentSession } from './session.js';
import { getActiveProvider, getActiveProviderAccount } from './wallet.js';
import { planByPda } from './solana/accounts.js';

/** Wrap an async handler: any throw becomes the JSON error body with the right status. */
export function route(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      if (res.headersSent) return next(err);
      sendError(res, err);
    }
  };
}

export function httpError(status, message, errorCode) {
  const e = new Error(message);
  e.status = status;
  if (errorCode) e.errorCode = errorCode;
  return e;
}

/** Validate a base58 pubkey string (on- or off-curve — PDAs are off-curve). Throws 400. */
export function pubkeyArg(s, label = 'address') {
  try {
    return new PublicKey(String(s || '').trim());
  } catch (err) {
    throw httpError(400, `${label} is not a valid Solana address`, 'invalid-address');
  }
}

/**
 * A wallet address someone can sign with: valid AND on the ed25519 curve. A PDA
 * (off-curve) has no private key, so a subscription gifted to one could never
 * request a ticket. Throws 400.
 */
export function walletArg(s, label = 'address') {
  const pk = pubkeyArg(s, label);
  if (!PublicKey.isOnCurve(pk.toBytes())) throw httpError(400, `${label} is a program-derived address, not a wallet`, 'not-a-wallet');
  return pk;
}

/** Positive integer argument within bounds; `undefined`/'' → fallback. */
export function intArg(v, label, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (v === undefined || v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw httpError(400, `${label} is required`, 'missing-field');
  }
  if (typeof v !== 'number' && typeof v !== 'string') throw httpError(400, `${label} must be an integer between ${min} and ${max}`, 'invalid-field');
  // Number() would accept "0x3c", "1e2" and " 60 "; only plain decimal digits are an integer here.
  if (typeof v === 'string' && !/^\d+$/.test(v.trim())) throw httpError(400, `${label} must be an integer between ${min} and ${max}`, 'invalid-field');
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${label} must be an integer between ${min} and ${max}`, 'invalid-field');
  return n;
}

// ─── Rate limiting (token bucket per ip+bucket) ──────────────────────────────
const _rl = new Map();
const RL_MAX_KEYS = 20_000; // spoofed client ips must not grow the map without bound
export function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${bucket}:${ip}`;
    const now = Date.now();
    const e = _rl.get(key) || { count: 0, reset: now + windowMs };
    if (now > e.reset) { e.count = 0; e.reset = now + windowMs; }
    e.count += 1;
    _rl.set(key, e);
    if (_rl.size > RL_MAX_KEYS) {
      for (const [k, v] of _rl) if (now > v.reset) _rl.delete(k);
      if (_rl.size > RL_MAX_KEYS) _rl.clear();
    }
    if (e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: 'Too many requests', errorCode: 'rate-limited' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rl) if (now > v.reset) _rl.delete(k);
}, 60_000).unref();

// ─── Operator context ────────────────────────────────────────────────────────
export function requireSession() {
  const s = currentSession();
  if (!s) throw httpError(401, 'Wallet not loaded. Import a key, connect a wallet, or sign in with Privy.', 'wallet-required');
  return s;
}

/** The provider this session acts as; 409 when the wallet owns none. */
export async function requireProvider(opts) {
  requireSession();
  const addr = await getActiveProvider(opts);
  if (!addr) throw httpError(409, 'This wallet has no provider yet — register one first', 'provider-required');
  const acct = await getActiveProviderAccount(opts);
  return { address: addr, account: acct };
}

/** Plan must exist and belong to the session's active provider. Returns the decoded plan. */
export async function assertPlanOwnership(planPda) {
  requireSession();
  const plan = await planByPda(pubkeyArg(planPda, 'planId'));
  if (!plan) throw httpError(404, 'Plan not found on chain', 'plan-not-found');
  const { address } = await requireProvider();
  if (plan.provider !== address) throw httpError(403, `Plan belongs to provider ${plan.provider}, not yours`, 'not-plan-owner');
  return plan;
}
