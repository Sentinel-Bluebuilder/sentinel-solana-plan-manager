// ─── Privy embedded Solana wallets ───────────────────────────────────────────
// Login: the browser runs Privy's email/OTP flow and forwards the access token.
// We verify it, then look up or create a `chain_type: 'solana'` wallet bound to
// that Privy userId (persisted in privy-wallets.json so the same user always
// gets the same pubkey). Signing: wallets().solana().signTransaction.
// The key never leaves Privy's enclave; the server only relays.
// SDK: @privy-io/node (replaces the deprecated @privy-io/server-auth).
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { VersionedTransaction } from '@solana/web3.js';

export const PRIVY_APP_ID = process.env.PRIVY_APP_ID || '';
export const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || '';
export const PRIVY_CLIENT_ID = process.env.PRIVY_CLIENT_ID || '';

export function privyEnabled() {
  return !!(PRIVY_APP_ID && PRIVY_APP_SECRET);
}

let _client = null;
export async function getPrivyClient() {
  if (!privyEnabled()) return null;
  if (!_client) {
    const { PrivyClient } = await import('@privy-io/node');
    _client = new PrivyClient({ appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET });
  }
  return _client;
}

/** Verify a Privy access token from the browser. Returns { userId }; throws if invalid. */
export async function verifyAccessToken(accessToken) {
  const privy = await getPrivyClient();
  if (!privy) throw new Error('Privy not configured');
  const claims = await privy.utils().auth().verifyAccessToken(accessToken);
  return { userId: claims?.user_id || null };
}

/** Create a Solana wallet in Privy. Returns { id, address, chain_type }. */
export async function createSolanaWallet() {
  const privy = await getPrivyClient();
  if (!privy) throw new Error('Privy not configured');
  const w = await privy.wallets().create({ chain_type: 'solana' });
  return { id: w.id, address: w.address, chain_type: 'solana' };
}

/** Sign a VersionedTransaction with a Privy Solana wallet; returns the signed tx. */
export async function signTransaction(walletId, tx) {
  const privy = await getPrivyClient();
  if (!privy) throw new Error('Privy not configured');
  const out = await privy.wallets().solana().signTransaction(walletId, { transaction: tx.serialize() });
  const b64 = out?.signed_transaction;
  if (!b64) throw new Error('Privy signTransaction returned no signed_transaction');
  return VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
}

// ─── userId → wallet ledger ──────────────────────────────────────────────────
let storePath = null;
export function initPrivyStore(dataDir) {
  storePath = join(dataDir, 'privy-wallets.json');
}

/**
 * The ledger maps Privy users to their Solana wallets. If it exists but cannot
 * be parsed, reads and writes both fail: treating it as empty would hand every
 * returning user a NEW wallet and the next save would erase the old mapping.
 */
function readStore() {
  if (!storePath || !existsSync(storePath)) return {};
  try {
    return JSON.parse(readFileSync(storePath, 'utf8')) || {};
  } catch (err) {
    const e = new Error(`privy-wallets.json is unreadable (${err.message}); fix or restore it before Privy logins can continue`);
    e.status = 503; e.errorCode = 'privy-store-corrupt';
    throw e;
  }
}

export function lookupWallet(userId) {
  const e = readStore()[userId];
  return e && e.walletId && e.pubkey ? e : null;
}

export function lookupWalletByPubkey(pubkey) {
  for (const [userId, e] of Object.entries(readStore())) if (e.pubkey === pubkey) return { userId, ...e };
  return null;
}

export function saveWallet(userId, entry) {
  const s = readStore();
  s[userId] = { ...(s[userId] || {}), ...entry, chain: 'solana', updatedAt: new Date().toISOString() };
  const tmp = `${storePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, storePath);
}
