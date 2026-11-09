// ─── Per-user sessions ───────────────────────────────────────────────────────
// Three session kinds, one shape consumed by lib/solana/tx.js:
//
//   keypair  server holds the secret key for the request's duration ONLY. It
//            rides in an httpOnly AES-256-GCM cookie (spm_sess) that carries its
//            issue time; nothing is persisted and the cached session object keeps
//            no secret between requests (releaseKeypair()).
//   wallet   browser extension (Phantom / Solflare / any Wallet Standard wallet)
//            holds the key; the server only knows the pubkey (HMAC-signed cookie
//            spm_wallet) and relays unsigned txs for the browser to sign.
//   privy    Privy embedded Solana wallet; the server asks Privy to sign.
//
// Session = { kind, pubkey: PublicKey, address: base58, keypair?: Keypair,
//             privyWalletId?: string, signTransaction?(tx), broadcastQueue }
import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { derivePath } from 'ed25519-hd-key';
import bs58 from 'bs58';

export const COOKIE_NAME = 'spm_sess';
export const WALLET_COOKIE_NAME = 'spm_wallet';
export const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'"; // Phantom / Solflare default
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const CACHE_MAX = 500;
/** Force the Secure cookie attribute (TLS terminated by a non-loopback proxy). */
export const SECURE_COOKIES = process.env.SECURE_COOKIES === '1';
export const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7;

const als = new AsyncLocalStorage();
let _key = null;

export function initSession(dataDir) {
  if (process.env.SESSION_KEY) {
    const buf = Buffer.from(process.env.SESSION_KEY, 'hex');
    if (buf.length === 32) { _key = buf; console.log('[session] Using SESSION_KEY from env'); return; }
    console.warn('[session] SESSION_KEY must be 32-byte hex (64 chars) — falling back to generated key');
  }
  const keyFile = join(dataDir, '.session-key');
  try {
    if (existsSync(keyFile)) {
      const buf = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
      if (buf.length === 32) { _key = buf; console.log(`[session] Loaded session key: ${keyFile}`); return; }
    }
  } catch (err) {
    console.warn('[session] Failed to read session key file:', err.message);
  }
  _key = randomBytes(32);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(keyFile, _key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(keyFile, 0o600); } catch (e) { console.warn(`[session] chmod on session key file failed (ok on Windows): ${e.message}`); }
    console.log(`[session] Generated session key: ${keyFile}`);
  } catch (err) {
    console.warn('[session] Could not persist session key — sessions will invalidate on restart:', err.message);
  }
}

export function isMultiUser() { return true; }

// ─── Secret-key material ─────────────────────────────────────────────────────
/**
 * Accepts what Solana users actually have: a solana-keygen JSON array (64 or
 * 32 bytes), a base58 secret key, or a BIP39 phrase (derived at m/44'/501'/0'/0').
 * Returns a Keypair. Throws a clear error otherwise.
 */
export function keypairFromInput(input) {
  try {
    return keypairFromInputUnchecked(input);
  } catch (e) {
    const err = new Error(e.message);
    err.status = 400;
    err.errorCode = 'invalid-key';
    throw err;
  }
}

function keypairFromInputUnchecked(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Empty key input');
  if (s.startsWith('[')) {
    let arr;
    try { arr = JSON.parse(s); } catch (e) { throw new Error(`Key JSON is not valid: ${e.message}`); }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('Key JSON must be an array of bytes');
    const bytes = Uint8Array.from(arr);
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
    throw new Error(`Key JSON must hold 64 (or 32) bytes, got ${bytes.length}`);
  }
  const words = s.split(/\s+/);
  if (words.length >= 12 && words.length <= 24 && words.length % 3 === 0) {
    const phrase = words.join(' ').toLowerCase();
    if (!validateMnemonic(phrase, wordlist)) throw new Error('Invalid BIP39 phrase (bad word or checksum)');
    const seed = mnemonicToSeedSync(phrase, '');
    const { key } = derivePath(SOLANA_DERIVATION_PATH, Buffer.from(seed).toString('hex'));
    return Keypair.fromSeed(key);
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(s)) {
    return Keypair.fromSecretKey(bs58.decode(s));
  }
  throw new Error('Unrecognised key format: paste a solana-keygen JSON array, a base58 secret key, or a 12/24-word phrase');
}

/** Cookie payload = the 64-byte secret key, base64. */
function secretToToken(keypair) { return Buffer.from(keypair.secretKey).toString('base64'); }
function tokenToKeypair(token) { return Keypair.fromSecretKey(Buffer.from(token, 'base64')); }

/** Plaintext = `<issuedAt>.<base64 secret>`; the age bound lives inside the ciphertext, not only in Max-Age. */
export function encryptSecret(keypair, issuedAt = Math.floor(Date.now() / 1000)) {
  if (!_key) throw new Error('Session key not initialized');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, _key, iv);
  const ct = Buffer.concat([cipher.update(`${issuedAt}.${secretToToken(keypair)}`, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

export function decryptSecret(token) {
  if (!_key) throw new Error('Session key not initialized');
  const buf = Buffer.from(token, 'base64url');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('Session cookie too short');
  const decipher = createDecipheriv(ALGO, _key, buf.subarray(0, IV_LEN));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  const plain = Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
  const dot = plain.indexOf('.');
  const age = Math.floor(Date.now() / 1000) - Number(plain.slice(0, dot));
  if (dot < 0 || !Number.isFinite(age) || age < -300 || age > COOKIE_MAX_AGE_SEC) throw new Error('Session cookie expired');
  return tokenToKeypair(plain.slice(dot + 1));
}

// ─── Session objects (LRU-cached per pubkey+kind) ────────────────────────────
const cache = new Map();
function remember(key, session) {
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, session);
  return session;
}

function baseSession(kind, pubkey) {
  return {
    kind,
    pubkey,
    address: pubkey.toBase58(),
    broadcastQueue: Promise.resolve(),
  };
}

/**
 * The cached object holds only NON-secret state (active provider, provider
 * list, broadcast queue). The keypair is attached while requests are using it
 * and dropped by releaseKeypair() when the last one finishes, so a closed tab
 * never leaves a secret key resident in the process.
 */
export function sessionFromKeypair(keypair) {
  const k = `keypair:${keypair.publicKey.toBase58()}`;
  let s = cache.get(k);
  if (s) { cache.delete(k); cache.set(k, s); } else { s = baseSession('keypair', keypair.publicKey); remember(k, s); }
  s.keypair = keypair;
  s._keyRefs = (s._keyRefs || 0) + 1;
  s.signTransaction = async (tx) => {
    if (!s.keypair) throw new Error('session key already released');
    tx.sign([s.keypair]);
    return tx;
  };
  return s;
}

/** Called when a request finishes; the secret is dropped once no request holds it. */
export function releaseKeypair(s) {
  if (!s || s.kind !== 'keypair') return;
  s._keyRefs = Math.max(0, (s._keyRefs || 1) - 1);
  if (s._keyRefs === 0) s.keypair = null;
}

export function sessionFromWallet(pubkeyB58) {
  const pubkey = new PublicKey(pubkeyB58);
  const k = `wallet:${pubkey.toBase58()}`;
  const hit = cache.get(k);
  if (hit) { cache.delete(k); cache.set(k, hit); return hit; }
  return remember(k, baseSession('wallet', pubkey));
}

/** `signer(tx) => Promise<VersionedTransaction>` is supplied by lib/privy.js. */
export function sessionFromPrivy(pubkeyB58, walletId, signer) {
  const pubkey = new PublicKey(pubkeyB58);
  const k = `privy:${pubkey.toBase58()}`;
  let s = cache.get(k);
  if (!s) {
    s = baseSession('privy', pubkey);
    remember(k, s);
  } else { cache.delete(k); cache.set(k, s); }
  s.privyWalletId = walletId;
  s.signTransaction = (tx) => signer(walletId, tx);
  return s;
}

export function dropSessionFromCache(kind, pubkeyB58) {
  cache.delete(`${kind}:${pubkeyB58}`);
}

// ─── AsyncLocalStorage ───────────────────────────────────────────────────────
export function runWithSession(session, fn) { return als.run(session, fn); }
export function currentSession() { return als.getStore() ?? null; }

// ─── Cookies ─────────────────────────────────────────────────────────────────
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(val); } catch (e) {
      console.warn(`[session] cookie "${name}" decode failed, using raw value: ${e.message}`);
      out[name] = val;
    }
  }
  return out;
}

function cookie(name, value, maxAge, secure) {
  const attrs = [`${name}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`];
  if (secure || SECURE_COOKIES) attrs.push('Secure');
  return attrs.join('; ');
}
export function buildSetCookie(token, { secure }) { return cookie(COOKIE_NAME, token, COOKIE_MAX_AGE_SEC, secure); }
export function buildClearCookie({ secure }) { return cookie(COOKIE_NAME, '', 0, secure); }
export function buildSetWalletCookie(token, { secure }) { return cookie(WALLET_COOKIE_NAME, token, COOKIE_MAX_AGE_SEC, secure); }
export function buildClearWalletCookie({ secure }) { return cookie(WALLET_COOKIE_NAME, '', 0, secure); }

/**
 * Wallet/Privy cookie = `kind|pubkey|walletId|issuedAt` HMAC-signed with the
 * session key, so a tampered cookie cannot promote an arbitrary pubkey into a
 * session, and a copied one stops working after COOKIE_MAX_AGE_SEC.
 */
export function buildWalletToken(kind, pubkeyB58, walletId = '', issuedAt = Math.floor(Date.now() / 1000)) {
  if (!_key) throw new Error('Session key not initialized');
  const payload = `${kind}|${pubkeyB58}|${walletId || ''}|${issuedAt}`;
  const mac = createHmac('sha256', _key).update(payload).digest('base64url');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${mac}`;
}

export function parseWalletToken(token) {
  if (!_key) throw new Error('Session key not initialized');
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  let payload;
  try { payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8'); } catch (e) {
    console.warn(`[session] parseWalletToken decode failed: ${e.message}`);
    return null;
  }
  const expect = Buffer.from(createHmac('sha256', _key).update(payload).digest('base64url'), 'utf8');
  const mac = Buffer.from(token.slice(dot + 1), 'utf8');
  if (expect.length !== mac.length || !timingSafeEqual(expect, mac)) return null;
  const [kind, pubkey, walletId, issuedAt] = payload.split('|');
  if (!['wallet', 'privy'].includes(kind)) return null;
  const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
  if (!Number.isFinite(age) || age < -300 || age > COOKIE_MAX_AGE_SEC) return null;
  try { new PublicKey(pubkey); } catch (e) { return null; }
  return { kind, pubkey, walletId: walletId || null };
}

export function hashSecret(keypair) {
  return createHash('sha256').update(keypair.secretKey).digest('hex');
}
