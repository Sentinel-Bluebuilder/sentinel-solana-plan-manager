#!/usr/bin/env node
// ─── Browser-wallet relay, proven without an extension ───────────────────────
// A local Keypair plays Phantom: challenge → signMessage → login (wallet
// session, server holds only the pubkey); a write route answers
// {mode:'wallet-sign', tx}; the harness signs the v0 tx and posts it to
// /api/tx/broadcast-signed. Positive path lands a real tx (free plan create +
// close, rent refunded). Negative paths: foreign fee payer and a
// non-allow-listed program are refused with 403. Uses the funded test key as
// the "extension" so the tx can actually land.
//   node scripts/test-wallet-relay.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram, Connection } from '@solana/web3.js';
import { keypairFromInput } from '../lib/session.js';

const BASE = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3003}`;
const kp = keypairFromInput(readFileSync(process.env.TEST_KEYFILE, 'utf8'));
let cookie = '';
let pass = 0; let fail = 0;
const log = (ok, name, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  const jar = Object.fromEntries((cookie ? cookie.split('; ') : []).map((p) => p.split('=')));
  for (const sc of list) { const [pair] = sc.split(';'); const i = pair.indexOf('='); const v = pair.slice(i + 1); if (v) jar[pair.slice(0, i)] = v; else delete jar[pair.slice(0, i)]; }
  cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  return { status: r.status, json: await r.json().catch(() => null) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`wallet-relay @ ${BASE} as ${kp.publicKey.toBase58()}`);
const ch = await call('POST', '/api/wallet/challenge');
const sig = Buffer.from(nacl.sign.detached(Buffer.from(ch.json.nonce, 'utf8'), kp.secretKey)).toString('base64');
const login = await call('POST', '/api/wallet/login', { pubkey: kp.publicKey.toBase58(), signature: sig, nonce: ch.json.nonce });
log(login.status === 200 && login.json.mode === 'wallet', 'challenge → signMessage → login gives a wallet session', JSON.stringify(login.json));
const st = await call('GET', '/api/wallet/status');
log(st.json?.kind === 'wallet', 'session kind is wallet (server holds no key)');
const replay = await call('POST', '/api/wallet/login', { pubkey: kp.publicKey.toBase58(), signature: sig, nonce: ch.json.nonce });
log(replay.status === 400, 'challenge is single-use', `status ${replay.status}`);

// ── positive: create a free plan through the relay ──
let planAddr = null;
try {
const create = await call('POST', '/api/plan/create', { priceTdvpn: '0', durationSeconds: 3600, dataCapGb: 1, maxConnections: 1 });
log(create.status === 200 && create.json?.mode === 'wallet-sign' && typeof create.json.tx === 'string', 'write route returns {mode:wallet-sign, tx}', JSON.stringify(create.json).slice(0, 120));
if (create.json?.tx) {
  const tx = VersionedTransaction.deserialize(Buffer.from(create.json.tx, 'base64'));
  log(tx.message.staticAccountKeys[0].equals(kp.publicKey), 'unsigned tx fee payer is the session pubkey');
  tx.sign([kp]);
  const sent = await call('POST', '/api/tx/broadcast-signed', { tx: Buffer.from(tx.serialize()).toString('base64'), label: create.json.label });
  log(sent.status === 200 && sent.json?.ok && sent.json.txHash, 'signed tx relayed and confirmed', sent.json?.txHash || JSON.stringify(sent.json));
  await sleep(7000);
  // The wallet-sign response names the plan the tx creates; check THAT plan,
  // never "a plan with matching terms" (that picked up strays from other runs).
  planAddr = create.json.planId || null;
  const shown = planAddr ? await call('GET', `/api/plans/${planAddr}`) : null;
  log(!!planAddr && shown?.status === 200 && shown.json.provider && shown.json.listed, 'the relayed plan (named in the wallet-sign response) is on chain', planAddr || 'wallet-sign response has no planId');
}

// ── negative: foreign fee payer ──
{
  const other = Keypair.generate();
  const conn = new Connection((process.env.SOLANA_RPC_URLS || 'https://api.devnet.solana.com').split(',')[0], 'confirmed');
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: other.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: kp.publicKey, lamports: 1 })] }).compileToV0Message());
  tx.sign([other]);
  const r = await call('POST', '/api/tx/broadcast-signed', { tx: Buffer.from(tx.serialize()).toString('base64') });
  log(r.status === 403, 'relay refuses a tx whose fee payer is not the session', `status ${r.status} ${r.json?.error || ''}`);
  // non-allow-listed program (memo)
  const memo = new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from('hi') });
  const tx2 = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: [memo] }).compileToV0Message());
  tx2.sign([kp]);
  const r2 = await call('POST', '/api/tx/broadcast-signed', { tx: Buffer.from(tx2.serialize()).toString('base64') });
  log(r2.status === 403, 'relay refuses a non-allow-listed program', `status ${r2.status} ${r2.json?.error || ''}`);
}

// Wallet-session gift cap: more than SUBSCRIPTIONS_PER_TX new subscribers is refused before any signing.
{
  const r = await call('POST', '/api/plan/add-subscribers', { planId: planAddr, addresses: Array.from({ length: 7 }, () => Keypair.generate().publicKey.toBase58()) });
  log(r.status === 400 && r.json?.errorCode === 'batch-too-large', 'wallet session: 7 gifts in one request → 400 batch-too-large (one tx per round-trip)', `status ${r.status} ${r.json?.errorCode || ''}`);
}
} finally {
// ── cleanup: close the plan through the relay too ──
if (planAddr) {
  await sleep(7000);
  const close = await call('POST', '/api/plan/close', { planId: planAddr });
  if (close.json?.tx) {
    const tx = VersionedTransaction.deserialize(Buffer.from(close.json.tx, 'base64')); tx.sign([kp]);
    const sent = await call('POST', '/api/tx/broadcast-signed', { tx: Buffer.from(tx.serialize()).toString('base64'), label: close.json.label });
    log(sent.status === 200 && sent.json?.ok, 'plan closed through the relay (cleanup)', sent.json?.txHash || JSON.stringify(sent.json));
    const gone = await call('GET', `/api/plans/${planAddr}`);
    log(gone.status === 404, 'that same plan is gone from chain (nothing leaked)', `status ${gone.status}`);
  } else log(false, 'plan close relay', JSON.stringify(close.json));
}
await call('POST', '/api/wallet/logout');
}
console.log(`\nwallet-relay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
