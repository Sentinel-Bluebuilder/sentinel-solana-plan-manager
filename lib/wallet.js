// ─── Wallet accessors ────────────────────────────────────────────────────────
// The wallet lives in the per-request session (lib/session.js). getAddr() is the
// Solana pubkey (base58). The operator acts as one provider at a time —
// getActiveProvider(): the Provider PDA this operator is acting as, resolved
// from chain (first LISTED provider owned by the session key, else the first
// one) and overridable per session with POST /api/provider/select.
import { currentSession } from './session.js';
import { providersByOwner, providerByPda } from './solana/accounts.js';

const ACTIVE_TTL_MS = 60_000;

export function getAddr() {
  const s = currentSession();
  return s ? s.address : null;
}

export function isWalletLoaded() {
  return !!currentSession();
}

export function requireWallet(req, res) {
  if (!currentSession()) {
    res.status(401).json({ error: 'Wallet not loaded. Import a key, connect a wallet, or sign in with Privy.', errorCode: 'wallet-required' });
    return false;
  }
  return true;
}

/**
 * All providers this session owns (cached per session for 60 s).
 * The owner search is a getProgramAccounts (10 gate credits, and the gate caps
 * those at 0.2/s per client), so it runs only to DISCOVER the set: first load,
 * an empty set, after open/close, or when a known provider vanished or changed
 * owner. Every other refresh re-reads the known accounts one by one (1 credit each).
 */
export async function getOwnedProviders({ fresh = false } = {}) {
  const s = currentSession();
  if (!s) return [];
  if (!fresh && s._providers && Date.now() - s._providersAt < ACTIVE_TTL_MS) return s._providers;
  let list = null;
  if (s._providers?.length && !s._providersRediscover) {
    const again = await Promise.all(s._providers.map((p) => providerByPda(p.address)));
    if (again.every((p) => p && p.owner === s.address)) list = again;
  }
  if (!list) list = await providersByOwner(s.address);
  s._providers = list;
  s._providersAt = Date.now();
  s._providersRediscover = false;
  return list;
}

/** The provider PDA (base58) this session acts as, or null when it owns none. */
export async function getActiveProvider(opts) {
  const s = currentSession();
  if (!s) return null;
  const list = await getOwnedProviders(opts);
  if (!list.length) { s.activeProvider = null; return null; }
  if (s.activeProvider && list.some((p) => p.address === s.activeProvider)) return s.activeProvider;
  const listed = list.find((p) => p.status === 1) || list[0];
  s.activeProvider = listed.address;
  return s.activeProvider;
}

export async function getActiveProviderAccount(opts) {
  const addr = await getActiveProvider(opts);
  if (!addr) return null;
  const s = currentSession();
  return (s._providers || []).find((p) => p.address === addr) || null;
}

export function setActiveProvider(addr) {
  const s = currentSession();
  if (s) s.activeProvider = addr;
}

/**
 * Mark the provider list stale. Writes that only change a provider's data
 * (revenue, plans, status) keep the known set and re-read it by address;
 * `rediscover` (open/close provider, or a relayed write of unknown kind) runs
 * the owner search again, since the set itself may have changed.
 */
export function invalidateProviders({ rediscover = false } = {}) {
  const s = currentSession();
  if (!s) return;
  s._providersAt = 0;
  if (rediscover) s._providersRediscover = true;
}
