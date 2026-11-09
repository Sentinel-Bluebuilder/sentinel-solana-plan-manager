#!/usr/bin/env node
// ─── Unit tests: decoders, PDAs, error tables, signing, sessions ─────────────
// Offline once fixtures exist. First run captures live devnet bytes into
// test/fixtures/*.json (gitignored data is NOT needed — fixtures are JSON with
// base64 account data and the values they must decode to).
//   node scripts/test-unit.mjs            (exit 0 = all pass)
//   CAPTURE=1 node scripts/test-unit.mjs  (re-capture fixtures from devnet)
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { DEPLOYED_SIZES, ACCOUNT_NAMES, NETWORK, protocolNames } from '../lib/solana/idl.js';
import { coder, pda } from '../lib/solana/program.js';
import { decodeAccount, tdvpn, toBaseUnits, baseUnitsArg, toLamports } from '../lib/solana/accounts.js';
import { describeProgramError, extractErrorCode, ProgramError } from '../lib/solana/errors.js';
import { parseChainError, chainErrorStatus, FRIENDLY } from '../lib/errors.js';
import * as nodeapi from '../lib/nodeapi.js';
import { initSession, keypairFromInput, encryptSecret, decryptSecret, buildWalletToken, parseWalletToken, sessionFromKeypair, releaseKeypair } from '../lib/session.js';
import { cached } from '../lib/cache.js';
import { initPrivyStore, lookupWallet, saveWallet } from '../lib/privy.js';
import { tmpdir } from 'node:os';
import { rpcCall } from '../lib/solana/rpc.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(here, '..', 'test', 'fixtures');
const FIX = join(FIX_DIR, 'devnet-accounts.json');
let pass = 0; let fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => { pass++; console.log(`  ✓ ${name}`); }, (e) => { fail++; console.log(`  ✗ ${name} — ${e.message}`); });
    pass++; console.log(`  ✓ ${name}`);
  } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
  return Promise.resolve();
}
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, what) => { if (!c) throw new Error(what || 'assertion failed'); };

// Known devnet anchors (verified by hand 2026-10-14).
const KNOWN = {
  owner: '11111111111111111111111111111111',
  provider: 'CdxxwuftRrZVj9EmtLFwNj9yVAgB6WNhC5KVdCH7HLV5',
  providerId: 'f96f869fefc63851a8461dfbc946a4a0945ccbd86fdff55c69d334ddf49595a2',
  config: 'Cu5vofxVQgZXRVwfBqApw84ZWy1hjhDmHkznyDr6TRiQ',
  plan: '38fjwHU3gGdfHAYeUnjX6LD9zXka82Kut2ooJwudYqLG',
  planId: '5204e14eba4b69f492e14702cea5189dfff8b7682745bae8f33a3551522c2d6d',
  node: '6AaXvhWpFDMf8FimxSb2Tb3bKcgPmbZxj4Tdtb31nP8F',
  lease: 'E5HXiW2h6u1AEWxhiJT34vACqGJ2TxJs9BZyn3itvMr2',
};

async function captureFixtures() {
  mkdirSync(FIX_DIR, { recursive: true });
  const out = {};
  for (const [name, addr] of [['config', KNOWN.config], ['provider', KNOWN.provider], ['plan', KNOWN.plan], ['node', KNOWN.node], ['lease', KNOWN.lease]]) {
    const info = await rpcCall((c) => c.getAccountInfo(new PublicKey(addr), 'confirmed'), { label: `fixture:${name}` });
    if (!info) throw new Error(`fixture ${name} ${addr} not found on devnet`);
    out[name] = { address: addr, data: Buffer.from(info.data).toString('base64') };
  }
  writeFileSync(FIX, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`captured ${Object.keys(out).length} fixtures → ${FIX}`);
  return out;
}

console.log('unit: IDL + sizes');
await t('network is devnet (tests encode devnet anchors)', () => eq(NETWORK, 'devnet'));
await t('patch-idl is deterministic (byte-identical on re-run)', () => {
  const p = join(here, '..', 'chain', 'idl', 'dvpn.devnet.json');
  const before = createHash('sha256').update(readFileSync(p)).digest('hex');
  execFileSync(process.execPath, [join(here, 'patch-idl.mjs')], { stdio: 'ignore' });
  eq(createHash('sha256').update(readFileSync(p)).digest('hex'), before, 'idl hash');
});
await t('coder sizes equal the deployed-size table for all 11 accounts', () => {
  for (const n of ACCOUNT_NAMES) eq(coder().size(n), DEPLOYED_SIZES[n], n);
  eq(coder().size('lease'), 331); eq(coder().size('channel'), 299); eq(coder().size('grant'), 201);
});

console.log('unit: decoders (live devnet bytes)');
const fixtures = (process.env.CAPTURE === '1' || !existsSync(FIX)) ? await captureFixtures() : JSON.parse(readFileSync(FIX, 'utf8'));
const dec = (n) => decodeAccount(n, Buffer.from(fixtures[n].data, 'base64'));
await t('config decodes (feeBps 200, bonds 1e6, unbonding 3600, ttl 86400)', () => {
  const c = dec('config'); eq(c.feeBps, 200); eq(c.minProviderBond, '1000000'); eq(c.unbondingSeconds, 3600); eq(c.nodeListingTtlSeconds, 86400); eq(c.mint, 'Hen2LVP6KooGaXEvdSyCHWghsEY4gLLn7wix8z6zHFSa');
});
await t('provider decodes (owner, id, bond, uri utf8)', () => {
  const p = dec('provider'); eq(p.owner, KNOWN.owner); eq(p.providerId, KNOWN.providerId); eq(p.bond, '1000000'); ok(p.uri.startsWith('https://'), 'uri'); ok(!('uriLen' in p), 'uriLen stripped');
});
await t('plan decodes (provider, id, price 1000, dur 3600)', () => {
  const p = dec('plan'); eq(p.provider, KNOWN.provider); eq(p.planId, KNOWN.planId); eq(p.price, '1000'); eq(p.durationSeconds, 3600);
});
await t('node decodes (owner, country utf8, protocol names, listed)', () => {
  const n = dec('node'); eq(n.owner, KNOWN.owner); eq(n.country.length, 2); ok(Array.isArray(n.protocolNames) && n.protocolNames.length >= 1, 'protocols'); eq(n.status, 1);
});
await t('lease decodes in the cb33 layout (331 B, opener + rentRecipient)', () => {
  const l = dec('lease'); eq(Buffer.from(fixtures.lease.data, 'base64').length, 331); eq(l.provider, KNOWN.provider); eq(l.node, KNOWN.node); ok('voucherSigner' in l, 'voucherSigner'); ok('opener' in l && 'rentRecipient' in l, 'cb33 fields'); ok([0, 1].includes(l.mode), 'mode'); ok(BigInt(l.escrow) >= BigInt(l.redeemed), 'escrow >= redeemed');
});

console.log('unit: PDAs');
await t('config PDA', () => eq(pda.config().toBase58(), KNOWN.config));
await t('provider PDA = [provider, owner, provider_id]', () => eq(pda.provider(KNOWN.owner, Buffer.from(KNOWN.providerId, 'hex')).toBase58(), KNOWN.provider));
await t('plan PDA = [plan, provider, plan_id]', () => eq(pda.plan(KNOWN.provider, Buffer.from(KNOWN.planId, 'hex')).toBase58(), KNOWN.plan));
await t('node PDA = [node, owner, node_id]', () => eq(pda.node(KNOWN.owner, Buffer.from(dec('node').nodeId, 'hex')).toBase58(), KNOWN.node));
await t('lease PDA = [lease, provider, lease_id]', () => eq(pda.lease(KNOWN.provider, Buffer.from(dec('lease').leaseId, 'hex')).toBase58(), KNOWN.lease));

console.log('unit: error tables');
await t('cb33 table: 6022 OpenLeasesRemain, 6023 BalanceZero, 6034 VoucherExceedsEscrow, 6036 RedeemableZero, 6037 ModeNotVoucher', () => {
  eq(describeProgramError(6022).name, 'OpenLeasesRemain'); eq(describeProgramError(6023).name, 'BalanceZero'); eq(describeProgramError(6034).name, 'VoucherExceedsEscrow');
  eq(describeProgramError(6036).name, 'RedeemableZero'); eq(describeProgramError(6037).name, 'ModeNotVoucher');
});
await t('cb33 table: 6003 ParamOutOfRange, 6021 OpenPlansRemain, 6039 InvalidVoucherSignature, 6046 PermissionNotGranted, 6050 InvalidRentRecipient', () => {
  eq(describeProgramError(6003).name, 'ParamOutOfRange'); eq(describeProgramError(6021).name, 'OpenPlansRemain'); eq(describeProgramError(6039).name, 'InvalidVoucherSignature');
  eq(describeProgramError(6046).name, 'PermissionNotGranted'); eq(describeProgramError(6050).name, 'InvalidRentRecipient');
});
await t('framework codes: 3012 AccountNotInitialized, 2006 ConstraintSeeds, 102 InstructionDidNotDeserialize', () => {
  eq(describeProgramError(3012).name, 'AccountNotInitialized'); eq(describeProgramError(2006).name, 'ConstraintSeeds'); eq(describeProgramError(102).name, 'InstructionDidNotDeserialize');
});
await t('extractErrorCode from log line / hex / Custom json', () => {
  eq(extractErrorCode(['Program log: AnchorError thrown. Error Code: PlanNotListed. Error Number: 6025. Error Message: x']), 6025);
  eq(extractErrorCode('failed: custom program error: 0x1772'), 6002);
  eq(extractErrorCode({ err: { InstructionError: [1, { Custom: 6040 }] } }), 6040);
  eq(extractErrorCode('nothing here'), null);
});
await t('ProgramError → 400 + friendly text; transport → 500; err.status wins', () => {
  const pe = new ProgramError({ err: { InstructionError: [0, { Custom: 6025 }] }, logs: [] });
  eq(chainErrorStatus(pe), 400); eq(parseChainError(pe), 'Plan is not listed — list it first.');
  eq(chainErrorStatus(new Error('fetch failed: ECONNRESET')), 500); eq(chainErrorStatus(new Error('all RPC endpoints failed')), 500);
  const e = new Error('x'); e.status = 409; eq(chainErrorStatus(e), 409);
  eq(parseChainError(new Error('Transfer: insufficient lamports 1, need 2')), 'Not enough SOL for the fee and rent — add SOL to this wallet and retry.');
});
// Plain-words check (sentinel-solana docs/43 §1, PLAN-cb33 built-in check): every cb33
// program error has operator wording; no name or number leaks into the text; sentence
// form; ≤ 180 characters.
// cb33 protocol bits (sentinel-go-sdk <proto> tests: wireguard 1<<0 … hysteria2 1<<5).
// Mutant check: the pre-cb33 table (xray 4, openvpn 8, hysteria2 16, amneziawg 32) fails here.
await t('protocol mask decodes with the cb33 bit table', () => {
  const want = { 1: 'wireguard', 2: 'v2ray', 4: 'openvpn', 8: 'amneziawg', 16: 'xray', 32: 'hysteria2' };
  for (const [bit, name] of Object.entries(want)) eq(protocolNames(Number(bit)).join(','), name);
  eq(protocolNames(63).join(','), 'wireguard,v2ray,openvpn,amneziawg,xray,hysteria2');
  eq(protocolNames(33).join(','), 'wireguard,hysteria2');
  eq(protocolNames(0).length, 0);
});
await t('plain words: every cb33 program error 6000–6050 has wording, no raw name/number', () => {
  for (let code = 6000; code <= 6050; code++) {
    const name = describeProgramError(code).name;
    ok(FRIENDLY[name], `no wording for ${code} ${name}`);
    const msg = parseChainError(new ProgramError({ err: { InstructionError: [0, { Custom: code }] }, logs: [] }));
    ok(!msg.includes(name) && !msg.includes(String(code)), `${code} leaks into "${msg}"`);
    ok(/^[A-Z].*[.?…]$/.test(msg) && msg.length <= 180 && !msg.includes('!'), `${code} copy form: "${msg}"`);
  }
});
await t('plain words: an unmapped code and plain errors come out as sentences without internals', () => {
  const unknown = parseChainError(new Error('failed: custom program error: 0x1f3f'));
  ok(!/0x|7999|Program error/.test(unknown), `leak: ${unknown}`); ok(/nothing changed/.test(unknown), 'states the money/state');
  eq(parseChainError(new Error('no revenue to withdraw')), 'No revenue to withdraw.');
  eq(parseChainError(new Error('Done?')), 'Done?');
  ok(parseChainError(new Error('')).endsWith('.'), 'empty message gets a fallback sentence');
});

console.log('unit: node-API signing (byte layout from sentinel-go-sdk/auth)');
const kp = Keypair.generate();
// Golden vectors printed by the real sentinel-go-sdk/auth @ cb33092e (seed = bytes 1..32,
// nonce = 16 × 0x07, pubkeys = 32 × N). Node must match byte for byte.
const GOLDEN = {
  domainApi: 'cfc919d8360f88cf73f2e6a91518f7e8f8a66e03a020845563025b6dce83a900', // gitleaks:allow (public test vector, not a secret)
  domainTicket: '3a5f7e2cb0f906a5ed2ba06b99bc65e4d1eb4d6e071db5088d97945436ff4a21', // gitleaks:allow (public test vector, not a secret)
  reqSig: 'm3VowCZlOxYPni36xr1z+sbCPxFarWpIo1xUJgdVl8dvtyqDdRg3Q/O5ticRT0kk3WLHVO9+h8HWe8VFiZyBCA==', // gitleaks:allow (public test vector, not a secret)
  ticketRequest: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwDxU2UAAAAABwcHBwcHBwcHBwcHBwcHB3m1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZkZs6j8GgUt7+SK1uICltOaF7kTXG/pxlPBv50bmyVnHjGu1q29GsQtIEWWXYeRUbDpszkA693pW8bcpJjjIdVDQ==', // gitleaks:allow (public test vector, not a secret)
  ticket: 'AQMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAPFTZQAAAAAQ/1NlAAAAAADKmjsAAAAAAgcHBwcHBwcHBwcHBwcHBwd5tVYuj+ZU+UB4sRLoqYunkB+FOuaVvtfg45ELrQSWZNJGF4KkWsa1UfLBkoyjKSS8ifDuc1C20vXsDpbFl8Vtaep6jWx3mu3shjh2n4Ur9nlhrg0PXGJdZ+NCJmm8Vg8=', // gitleaks:allow (public test vector, not a secret)
  signer: '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj',
};
const goldenKp = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const goldenNonce = Buffer.alloc(16, 7);
const pkN = (n) => new PublicKey(Buffer.alloc(32, n)).toBase58();
await t('cb33 domains = sha256(tag), equal to the Go SDK', () => {
  eq(nodeapi.DOMAIN_API_REQUEST.toString('hex'), GOLDEN.domainApi, 'api-request'); eq(nodeapi.DOMAIN_TICKET.toString('hex'), GOLDEN.domainTicket, 'ticket');
  eq(goldenKp.publicKey.toBase58(), GOLDEN.signer, 'golden signer');
});
await t('request signature is byte-identical to the Go SDK', () => {
  const msg = nodeapi.requestMessage('POST', '/v1/tickets', Buffer.from('{"a":1}'), 1700000000, goldenNonce);
  eq(nodeapi.signDomain(goldenKp.secretKey, nodeapi.DOMAIN_API_REQUEST, msg).toString('base64'), GOLDEN.reqSig);
});
await t('signed ticket request wire is byte-identical to the Go SDK', () => {
  const req = nodeapi.encodeTicketRequest({ subscription: pkN(1), node: pkN(2), provider: pkN(3), requestedAt: 1700000000, nonce: goldenNonce });
  const wire = Buffer.concat([req, goldenKp.publicKey.toBuffer(), nodeapi.signDomain(goldenKp.secretKey, nodeapi.DOMAIN_TICKET_REQUEST, req)]);
  eq(wire.toString('base64'), GOLDEN.ticketRequest);
});
await t('a Go-signed cb33 ticket decodes and verifies', () => {
  const d = nodeapi.decodeTicket(GOLDEN.ticket);
  ok(d.signatureValid, 'signature'); eq(d.signer, GOLDEN.signer); eq(d.provider, pkN(3)); eq(d.node, pkN(2)); eq(d.user, pkN(4)); eq(d.subscription, pkN(1));
  eq(d.expiresAt - d.issuedAt, 3600); eq(d.dataCapBytes, '1000000000'); eq(d.maxConnections, 2);
});
await t('requestMessage layout: u8 len ‖ method ‖ u16le len ‖ path ‖ u64le ts ‖ nonce16 ‖ sha256(body)', () => {
  const nonce = Buffer.alloc(16, 7);
  const m = nodeapi.requestMessage('GET', '/v1/health', Buffer.alloc(0), 1700000000, nonce);
  eq(m.length, 1 + 3 + 2 + 10 + 8 + 16 + 32); eq(m[0], 3); eq(m.subarray(1, 4).toString(), 'GET'); eq(m.readUInt16LE(4), 10); eq(m.subarray(6, 16).toString(), '/v1/health');
  eq(Number(m.readBigUInt64LE(16)), 1700000000); eq(m.subarray(24, 40).equals(nonce), true);
  eq(m.subarray(40).toString('hex'), createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
});
await t('signRequest headers verify under the api-request domain and fail under another', () => {
  const body = Buffer.from('{"a":1}');
  const h = nodeapi.signRequest(kp, 'POST', '/v1/tickets', body, 1700000000);
  const msg = nodeapi.requestMessage('POST', '/v1/tickets', body, 1700000000, Buffer.from(h['X-Sentinel-Nonce'], 'base64'));
  const sig = Buffer.from(h['X-Sentinel-Signature'], 'base64');
  eq(h['X-Sentinel-Signer'], kp.publicKey.toBase58()); eq(sig.length, 64);
  eq(nodeapi.verifyDomain(kp.publicKey, nodeapi.DOMAIN_API_REQUEST, msg, sig), true);
  eq(nodeapi.verifyDomain(kp.publicKey, nodeapi.DOMAIN_TICKET_REQUEST, msg, sig), false);
});
await t('ticket request wire = 121 B borsh + signer32 + sig64 = 217 B, version 1', () => {
  const w = Buffer.from(nodeapi.signTicketRequest(kp, { subscription: kp.publicKey, node: kp.publicKey, provider: kp.publicKey }, 1700000000), 'base64');
  eq(w.length, 217); eq(w[0], 1); eq(new PublicKey(w.subarray(121, 153)).toBase58(), kp.publicKey.toBase58());
  eq(nodeapi.verifyDomain(kp.publicKey, nodeapi.DOMAIN_TICKET_REQUEST, w.subarray(0, 121), w.subarray(153)), true);
});
await t('decodeTicket round-trips a self-issued ticket and validates its signature', () => {
  const b = Buffer.alloc(1 + 32 * 4 + 8 + 8 + 8 + 1 + 16);
  let o = 0; b.writeUInt8(1, o); o += 1;
  for (let i = 0; i < 4; i++) { kp.publicKey.toBuffer().copy(b, o); o += 32; }
  b.writeBigInt64LE(1700000000n, o); o += 8; b.writeBigInt64LE(1700003600n, o); o += 8; b.writeBigUInt64LE(2000000n, o); o += 8; b.writeUInt8(1, o); o += 1; Buffer.alloc(16, 9).copy(b, o);
  const sig = nodeapi.signDomain(kp.secretKey, nodeapi.DOMAIN_TICKET, b);
  const tk = nodeapi.decodeTicket(Buffer.concat([b, kp.publicKey.toBuffer(), sig]).toString('base64'));
  eq(tk.version, 1); eq(tk.expiresAt, 1700003600); eq(tk.dataCapBytes, '2000000'); eq(tk.maxConnections, 1); eq(tk.signatureValid, true); eq(tk.signer, kp.publicKey.toBase58());
});

console.log('unit: sessions + cookies');
initSession(join(here, '..', 'test'));
await t('keypairFromInput: 64-byte JSON array, 32-byte seed, base58, BIP39 (deterministic, Solana path)', () => {
  const a = keypairFromInput(JSON.stringify(Array.from(kp.secretKey))); eq(a.publicKey.toBase58(), kp.publicKey.toBase58());
  const seed = keypairFromInput(JSON.stringify(Array.from(kp.secretKey.slice(0, 32)))); eq(seed.publicKey.toBase58(), kp.publicKey.toBase58());
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const p1 = keypairFromInput(phrase); const p2 = keypairFromInput(phrase); eq(p1.publicKey.toBase58(), p2.publicKey.toBase58());
  ok(p1.publicKey.toBase58() !== kp.publicKey.toBase58());
  let threw = false; try { keypairFromInput('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'); } catch (e) { threw = /checksum|Invalid/.test(e.message); } ok(threw, 'bad checksum rejected');
});
await t('secret cookie encrypt/decrypt round-trip; tamper rejected', () => {
  const tok = encryptSecret(kp); eq(decryptSecret(tok).publicKey.toBase58(), kp.publicKey.toBase58());
  let threw = false; try { decryptSecret(tok.slice(0, -4) + 'AAAA'); } catch (e) { threw = true; } ok(threw);
});
await t('wallet token HMAC: parses, rejects tamper and unknown kind', () => {
  const tok = buildWalletToken('wallet', kp.publicKey.toBase58());
  const p = parseWalletToken(tok); eq(p.kind, 'wallet'); eq(p.pubkey, kp.publicKey.toBase58());
  eq(parseWalletToken(tok.replace(/\.[^.]+$/, '.AAAA')), null);
  const other = Keypair.generate().publicKey.toBase58();
  eq(parseWalletToken(Buffer.from(`wallet|${other}|`).toString('base64url') + tok.slice(tok.lastIndexOf('.'))), null);
});
await t('wallet token expires with the cookie (7 days), validly signed or not', () => {
  const now = Math.floor(Date.now() / 1000);
  ok(parseWalletToken(buildWalletToken('wallet', kp.publicKey.toBase58(), '', now - 6 * 86400)), 'six-day-old token rejected');
  eq(parseWalletToken(buildWalletToken('wallet', kp.publicKey.toBase58(), '', now - 8 * 86400)), null);
  eq(parseWalletToken(buildWalletToken('wallet', kp.publicKey.toBase58(), '', now + 3600)), null);
});
await t('keypair session signs a tx', async () => {
  const s = sessionFromKeypair(kp); eq(s.kind, 'keypair'); eq(s.address, kp.publicKey.toBase58()); ok(typeof s.signTransaction === 'function');
  releaseKeypair(s);
});
await t('key cookie expires after COOKIE_MAX_AGE_SEC', () => {
  const now = Math.floor(Date.now() / 1000);
  eq(decryptSecret(encryptSecret(kp, now)).publicKey.toBase58(), kp.publicKey.toBase58());
  let threw = false; try { decryptSecret(encryptSecret(kp, now - 8 * 86400)); } catch (e) { threw = true; } ok(threw, 'old cookie rejected');
});
await t('secret key is released from the cached session when the last request ends', () => {
  const a = sessionFromKeypair(kp); const b = sessionFromKeypair(kp); ok(a === b, 'same cached object');
  releaseKeypair(a); ok(b.keypair, 'still held by the second request');
  releaseKeypair(b); ok(b.keypair === null, 'released'); ok(!('secretKey' in b), 'no secret on the cached object');
});

console.log('unit: units + cache');
await t('tdvpn/toBaseUnits round-trip', () => {
  eq(tdvpn('1000000'), '1'); eq(tdvpn('1000'), '0.001'); eq(tdvpn('0'), '0'); eq(tdvpn('1000993944869'), '1000993.944869');
  eq(toBaseUnits('1'), '1000000'); eq(toBaseUnits('0.001'), '1000'); eq(toBaseUnits('12.345678'), '12345678');
  let threw = false; try { toBaseUnits('1.1234567'); } catch (e) { threw = true; } ok(threw, '7 decimals rejected');
});
const rejects400 = (fn, label) => { let e = null; try { fn(); } catch (err) { e = err; } ok(e && e.status === 400, `${label} must be rejected with 400`); };
await t('amount parsers reject signs, hex, exponents and u64 overflow', () => {
  eq(toBaseUnits('18446744073709.551615'), '18446744073709551615');
  rejects400(() => toBaseUnits('18446744073709.551616'), 'tDVPN > u64');
  eq(baseUnitsArg('5'), '5'); eq(baseUnitsArg(' 0 '), '0');
  for (const v of ['-5', '1.5', 'abc', '0x10', '1e3', '', '18446744073709551616']) rejects400(() => baseUnitsArg(v), `base units "${v}"`);
  eq(toLamports('1'), 1_000_000_000n); eq(toLamports('0.000000001'), 1n);
  for (const v of ['0x10', '1e3', '-1', ' ', '0.0000000001', 'Infinity']) rejects400(() => toLamports(v), `SOL "${v}"`);
});
await t('failed SOL transfer reads as insufficient SOL, token shortfall as tDVPN', () => {
  const sol = new ProgramError({ err: { InstructionError: [0, { Custom: 1 }] } }, { logs: ['Program 11111111111111111111111111111111 invoke [1]', 'Transfer: insufficient lamports 5, need 16000000000', 'Program 11111111111111111111111111111111 failed: custom program error: 0x1'] });
  eq(sol.message, 'insufficient SOL balance');
  const tok = new ProgramError({ err: { InstructionError: [1, { Custom: 1 }] } }, { logs: ['Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [1]', 'Program log: Error: insufficient funds', 'Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1'] });
  eq(tok.message, 'insufficient tDVPN balance');
});
await t('a corrupt privy-wallets.json is refused, never overwritten', () => {
  const dir = join(tmpdir(), `plans-privy-${process.pid}`); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'privy-wallets.json'); writeFileSync(file, '{garbage', 'utf8');
  initPrivyStore(dir);
  let e = null; try { lookupWallet('u1'); } catch (err) { e = err; } ok(e && e.status === 503 && e.errorCode === 'privy-store-corrupt', 'lookup must fail with 503 privy-store-corrupt');
  e = null; try { saveWallet('u1', { walletId: 'w', pubkey: 'p' }); } catch (err) { e = err; } ok(e && e.errorCode === 'privy-store-corrupt', 'save must refuse');
  eq(readFileSync(file, 'utf8'), '{garbage', 'ledger left untouched');
});
await t('TLS pin: wrong pin tears the handshake down, right pin and no pin connect', async () => {
  // Needs openssl for a throwaway self-signed certificate; absent → reported, not silently passed.
  const dir = join(tmpdir(), `plans-pin-${process.pid}`); mkdirSync(dir, { recursive: true });
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  } catch (e) { throw new Error(`openssl unavailable, pin test not run: ${e.message}`); }
  const https = await import('node:https');
  let hits = 0;
  const srv = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => { hits++; res.end('{"ok":true}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${srv.address().port}/v1/health`;
  const pin = createHash('sha256').update(new (await import('node:crypto')).X509Certificate(readFileSync(join(dir, 'c.pem'))).raw).digest('hex');
  try {
    eq((await nodeapi.httpsRequest(url, { pinSha256: pin })).status, 200, 'right pin');
    eq((await nodeapi.httpsRequest(url)).status, 200, 'no pin (first contact)');
    let e = null; try { await nodeapi.httpsRequest(url, { pinSha256: '00'.repeat(32) }); } catch (err) { e = err; }
    ok(e && e.errorCode === 'tls-pin-mismatch', `wrong pin must be refused, got ${e && e.message}`);
    eq(hits, 2, 'the wrong-pin request never reached the server');
  } finally { srv.close(); }
});
await t('cached() de-duplicates concurrent callers', async () => {
  let n = 0; const fn = async () => { n++; await new Promise((r) => setTimeout(r, 20)); return n; };
  const [a, b] = await Promise.all([cached('unit:x', 1000, fn), cached('unit:x', 1000, fn)]); eq(a, 1); eq(b, 1); eq(n, 1);
});

console.log(`\nunit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
