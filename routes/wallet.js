// ─── Wallet + login + tx relay ───────────────────────────────────────────────
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import nacl from 'tweetnacl';
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { route, httpError, rateLimit, pubkeyArg, requireSession } from '../lib/http.js';
import {
  keypairFromInput, encryptSecret, sessionFromWallet, sessionFromPrivy, dropSessionFromCache, currentSession,
  buildSetCookie, buildClearCookie, buildWalletToken, buildSetWalletCookie, buildClearWalletCookie,
} from '../lib/session.js';
import { getAddr, getActiveProvider, invalidateProviders } from '../lib/wallet.js';
import { rpcCall } from '../lib/solana/rpc.js';
import { MINT, NETWORK, EXPLORER_CLUSTER, TOKEN_DECIMALS } from '../lib/solana/idl.js';
import { ata } from '../lib/solana/program.js';
import { tdvpn, toBaseUnits, toLamports } from '../lib/solana/accounts.js';
import { broadcastOrRelay, relaySignedTx } from '../lib/solana/tx.js';
import { cached, cacheInvalidate, cacheInvalidatePrefix } from '../lib/cache.js';
import * as privy from '../lib/privy.js';

const r = Router();
const CHALLENGE_TTL_MS = 5 * 60_000;
const challenges = new Map();
function gcChallenges() { const now = Date.now(); for (const [n, exp] of challenges) if (exp < now) challenges.delete(n); }

export function explorerUrl(kind, id) {
  const q = EXPLORER_CLUSTER ? `?cluster=${EXPLORER_CLUSTER}` : '';
  return `https://explorer.solana.com/${kind}/${id}${q}`;
}

function sessionInfo() {
  const s = currentSession();
  return { loaded: !!s, address: s?.address || null, kind: s?.kind || null, network: NETWORK };
}

r.get('/api/wallet/status', (req, res) => res.json({ ...sessionInfo(), multiUser: true, demo: false }));

r.post('/api/wallet/generate', rateLimit('wgen', 10, 60_000), route(async (req, res) => {
  const kp = Keypair.generate();
  res.setHeader('Set-Cookie', [buildClearWalletCookie({ secure: req.secure }), buildSetCookie(encryptSecret(kp), { secure: req.secure })]);
  res.setHeader('Cache-Control', 'no-store');
  // The secret is returned ONCE so the operator can back it up; it is never persisted server-side.
  res.json({ ok: true, address: kp.publicKey.toBase58(), secretKey: Array.from(kp.secretKey), mode: 'keypair', network: NETWORK });
}));

r.post('/api/wallet/import', rateLimit('wimp', 20, 60_000), route(async (req, res) => {
  const input = req.body?.key ?? req.body?.phrase ?? req.body?.secretKey;
  if (!input) throw httpError(400, 'key required (solana-keygen JSON array, base58 secret key, or BIP39 phrase)', 'missing-field');
  const kp = keypairFromInput(typeof input === 'string' ? input : JSON.stringify(input));
  res.setHeader('Set-Cookie', [buildClearWalletCookie({ secure: req.secure }), buildSetCookie(encryptSecret(kp), { secure: req.secure })]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, address: kp.publicKey.toBase58(), mode: 'keypair', network: NETWORK });
}));

r.post('/api/wallet/logout', (req, res) => {
  const s = currentSession();
  if (s) dropSessionFromCache(s.kind, s.address);
  res.setHeader('Set-Cookie', [buildClearCookie({ secure: req.secure }), buildClearWalletCookie({ secure: req.secure })]);
  res.json({ ok: true });
});

// ─── Browser wallet (Phantom / Solflare / Wallet Standard) ───────────────────
r.post('/api/wallet/challenge', rateLimit('wchal', 30, 60_000), (req, res) => {
  gcChallenges();
  const nonce = `Sign in to Sentinel Plan Manager\n\nnonce: ${Date.now()}-${randomBytes(16).toString('hex')}`;
  challenges.set(nonce, Date.now() + CHALLENGE_TTL_MS);
  res.json({ nonce });
});

r.post('/api/wallet/login', rateLimit('wlogin', 20, 60_000), route(async (req, res) => {
  const { pubkey, signature, nonce } = req.body || {};
  if (!pubkey || !signature || !nonce) throw httpError(400, 'pubkey, signature, nonce required', 'missing-field');
  if (!challenges.has(nonce)) throw httpError(400, 'Unknown or expired challenge', 'bad-challenge');
  challenges.delete(nonce);
  const pk = pubkeyArg(pubkey, 'pubkey');
  const sig = Buffer.from(String(signature), 'base64');
  if (sig.length !== 64 || !nacl.sign.detached.verify(Buffer.from(nonce, 'utf8'), sig, pk.toBytes())) {
    throw httpError(401, 'Signature verification failed', 'bad-signature');
  }
  sessionFromWallet(pk.toBase58());
  res.setHeader('Set-Cookie', [buildClearCookie({ secure: req.secure }), buildSetWalletCookie(buildWalletToken('wallet', pk.toBase58()), { secure: req.secure })]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, address: pk.toBase58(), mode: 'wallet', network: NETWORK });
}));

// ─── Privy ───────────────────────────────────────────────────────────────────
r.get('/api/wallet/privy-config', (req, res) => {
  res.json({ enabled: privy.privyEnabled(), appId: privy.PRIVY_APP_ID || null, clientId: privy.PRIVY_CLIENT_ID || null, chain: 'solana' });
});

r.post('/api/wallet/privy-login', rateLimit('plogin', 20, 60_000), route(async (req, res) => {
  const client = await privy.getPrivyClient();
  if (!client) throw httpError(503, 'Privy not configured. Set PRIVY_APP_ID and PRIVY_APP_SECRET in .env.', 'privy-off');
  const { accessToken } = req.body || {};
  if (!accessToken) throw httpError(400, 'accessToken required', 'missing-field');
  let verified;
  try { verified = await privy.verifyAccessToken(accessToken); } catch (err) { throw httpError(401, `Privy token verification failed: ${err.message}`, 'privy-token'); }
  if (!verified?.userId) throw httpError(401, 'Privy token missing userId', 'privy-token');
  let entry = privy.lookupWallet(verified.userId);
  if (!entry) {
    const w = await privy.createSolanaWallet();
    entry = { walletId: w.id, pubkey: w.address };
    privy.saveWallet(verified.userId, entry);
  }
  sessionFromPrivy(entry.pubkey, entry.walletId, privy.signTransaction);
  res.setHeader('Set-Cookie', [buildClearCookie({ secure: req.secure }), buildSetWalletCookie(buildWalletToken('privy', entry.pubkey, entry.walletId), { secure: req.secure })]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, address: entry.pubkey, mode: 'privy', userId: verified.userId, network: NETWORK });
}));

// ─── Relay ───────────────────────────────────────────────────────────────────
// The route that built a relayed tx returned before it landed, so it never
// cleared its caches. The relay cannot know which write it carried: drop every
// chain-derived read this wallet could be looking at.
function afterRelayedWrite() {
  invalidateProviders({ rediscover: true });
  cacheInvalidate(`balance:${getAddr()}`);
  for (const p of ['plans:', 'subs:', 'providers:']) cacheInvalidatePrefix(p);
}

r.post('/api/tx/broadcast-signed', rateLimit('relay', 30, 60_000), route(async (req, res) => {
  requireSession();
  const { tx, label } = req.body || {};
  if (!tx || typeof tx !== 'string') throw httpError(400, 'tx (base64 signed VersionedTransaction) required', 'missing-field');
  const result = await relaySignedTx(tx, { label: label || 'relay' });
  afterRelayedWrite();
  res.json({ ...result, label: label || 'relay' });
}));

// ─── Balances / send ─────────────────────────────────────────────────────────
export async function readBalances(address) {
  const pk = new PublicKey(address);
  const tokenAccount = ata(pk);
  const [lamports, token] = await Promise.all([
    rpcCall((c) => c.getBalance(pk, 'confirmed'), { label: 'balance:sol' }),
    rpcCall((c) => c.getTokenAccountBalance(tokenAccount, 'confirmed'), { label: 'balance:tdvpn', fallback: null }).catch((err) => {
      if (/could not find account|Invalid param/i.test(err.message)) return null;
      throw err;
    }),
  ]);
  const base = token?.value?.amount || '0';
  return {
    sol: { lamports, amount: (lamports / LAMPORTS_PER_SOL).toFixed(6) },
    tdvpn: { baseUnits: base, amount: tdvpn(base), ata: tokenAccount.toBase58(), exists: !!token },
  };
}

r.get('/api/wallet', route(async (req, res) => {
  const s = requireSession();
  const bal = await cached(`balance:${s.address}`, 15_000, () => readBalances(s.address));
  const provider = await getActiveProvider();
  res.json({
    address: s.address, kind: s.kind, network: NETWORK, mint: MINT.toBase58(), decimals: TOKEN_DECIMALS,
    ...bal, provider, explorer: explorerUrl('address', s.address),
  });
}));

r.get('/api/wallet/qr', route(async (req, res) => {
  const s = requireSession();
  const dataUrl = await QRCode.toDataURL(s.address, { margin: 1, width: 220 });
  res.json({ address: s.address, dataUrl });
}));

r.post('/api/wallet/send', rateLimit('wsend', 30, 60_000), route(async (req, res) => {
  const s = requireSession();
  const { to, amount } = req.body || {};
  const asset = String(req.body?.asset || 'TDVPN').toUpperCase();
  const dest = pubkeyArg(to, 'to');
  if (amount === undefined || amount === null || amount === '') throw httpError(400, 'amount required', 'missing-field');
  const ixs = [];
  if (asset === 'SOL') {
    const lamports = toLamports(amount);
    if (lamports <= 0n) throw httpError(400, 'amount must be a positive SOL amount', 'invalid-field');
    ixs.push(SystemProgram.transfer({ fromPubkey: s.pubkey, toPubkey: dest, lamports }));
  } else if (asset === 'TDVPN') {
    const base = BigInt(toBaseUnits(amount));
    if (base <= 0n) throw httpError(400, 'amount must be positive', 'invalid-field');
    const destAta = getAssociatedTokenAddressSync(MINT, dest, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(s.pubkey, destAta, dest, MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    ixs.push(createTransferCheckedInstruction(ata(s.pubkey), MINT, destAta, s.pubkey, base, TOKEN_DECIMALS, [], TOKEN_2022_PROGRAM_ID));
  } else {
    throw httpError(400, 'asset must be SOL or TDVPN', 'invalid-field');
  }
  const out = await broadcastOrRelay(ixs, res, `send:${asset}`, { to: dest.toBase58(), asset, amount: String(amount) });
  if (out.relayed) return;
  cacheInvalidate(`balance:${s.address}`);
  res.json({ ...out.result, to: dest.toBase58(), asset, amount: String(amount) });
}));

export default r;
