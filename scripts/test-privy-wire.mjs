#!/usr/bin/env node
// ─── Privy wire test ─────────────────────────────────────────────────────────
// Proves lib/privy.js drives @privy-io/node correctly without Privy credentials:
// a fake fetch plays api.privy.io (JWKS, wallet create, wallet RPC) and records
// what the SDK sends. Covers token verification (good, wrong audience, expired),
// wallet creation and Solana transaction signing.
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const APP_ID = 'wire-test-app';
process.env.PRIVY_APP_ID = APP_ID;
process.env.PRIVY_APP_SECRET = 'wire-test-secret';

// jose is the SDK's own JWT library; resolve it from there so the test signs tokens the same way.
const require = createRequire(import.meta.url);
const sdkDir = dirname(require.resolve('@privy-io/node'));
const { generateKeyPair, exportJWK, SignJWT } = await import(require.resolve('jose', { paths: [sdkDir] }));

let pass = 0;
let fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── Fake api.privy.io ───────────────────────────────────────────────────────
const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'wire-kid', alg: 'ES256', use: 'sig' };
const signer = Keypair.generate();
const calls = [];

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || input.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || input.headers || {});
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url, method, headers, body });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const path = new URL(url).pathname;
  if (path === `/v1/apps/${APP_ID}/jwks.json`) return json({ keys: [jwk] });
  if (path === '/v1/wallets' && method === 'POST') {
    return json({ id: 'wallet-1', address: signer.publicKey.toBase58(), chain_type: 'solana', created_at: Date.now(), owner_id: null, additional_signers: [], policy_ids: [] });
  }
  if (path === '/v1/wallets/wallet-1/rpc' && method === 'POST') {
    const tx = VersionedTransaction.deserialize(Buffer.from(body.params.transaction, 'base64'));
    tx.sign([signer]);
    return json({ method: 'signTransaction', data: { signed_transaction: Buffer.from(tx.serialize()).toString('base64'), encoding: 'base64' } });
  }
  return json({ error: `unexpected ${method} ${path}` }, 404);
};

const privy = await import('../lib/privy.js');

async function token({ aud = APP_ID, exp = '1h', sub = 'did:privy:user-1' } = {}) {
  return new SignJWT({ sid: 'session-1' }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'wire-kid' })
    .setIssuer('privy.io').setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime(exp).sign(privateKey);
}

console.log('privy wire:');

// ─── Token verification ──────────────────────────────────────────────────────
const v = await privy.verifyAccessToken(await token());
ok(v.userId === 'did:privy:user-1', 'verifyAccessToken: valid token → userId', JSON.stringify(v));
ok(calls.some((c) => c.url.endsWith(`/v1/apps/${APP_ID}/jwks.json`)), 'JWKS fetched from the app endpoint');

let refused = null;
try { await privy.verifyAccessToken(await token({ aud: 'other-app' })); } catch (err) { refused = err; }
ok(refused !== null, 'verifyAccessToken: token for another app → throws');
refused = null;
try { await privy.verifyAccessToken(await token({ exp: Math.floor(Date.now() / 1000) - 60 })); } catch (err) { refused = err; }
ok(refused !== null, 'verifyAccessToken: expired token → throws');

// ─── Wallet create ───────────────────────────────────────────────────────────
const w = await privy.createSolanaWallet();
const create = calls.find((c) => c.url.endsWith('/v1/wallets') && c.method === 'POST');
ok(w.id === 'wallet-1' && w.address === signer.publicKey.toBase58(), 'createSolanaWallet → { id, address }');
ok(create?.body?.chain_type === 'solana', 'create sends chain_type=solana', JSON.stringify(create?.body));
const basic = `Basic ${Buffer.from(`${APP_ID}:wire-test-secret`).toString('base64')}`;
ok(create?.headers.get('authorization') === basic, 'create authenticates with app id + secret');
ok(create?.headers.get('privy-app-id') === APP_ID, 'create sends privy-app-id');

// ─── Sign ────────────────────────────────────────────────────────────────────
const msg = new TransactionMessage({
  payerKey: signer.publicKey,
  recentBlockhash: new PublicKey(Keypair.generate().publicKey).toBase58(),
  instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
}).compileToV0Message();
const unsigned = new VersionedTransaction(msg);
const signed = await privy.signTransaction('wallet-1', unsigned);
const rpc = calls.find((c) => c.url.endsWith('/v1/wallets/wallet-1/rpc'));
ok(rpc?.body?.method === 'signTransaction' && rpc?.body?.chain_type === 'solana' && rpc?.body?.params?.encoding === 'base64', 'sign sends method/chain_type/base64', JSON.stringify(rpc?.body).slice(0, 160));
ok(Buffer.from(rpc?.body?.params?.transaction || '', 'base64').equals(Buffer.from(unsigned.serialize())), 'sign sends our exact unsigned transaction');
ok(signed instanceof VersionedTransaction && signed.signatures[0].some((b) => b !== 0), 'signTransaction → signed VersionedTransaction');
ok(Buffer.from(signed.message.serialize()).equals(Buffer.from(msg.serialize())), 'signed message unchanged');

console.log(`privy wire: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
