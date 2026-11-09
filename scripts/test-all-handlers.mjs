#!/usr/bin/env node
// ─── Route sweep: every endpoint, every error branch, zero spend ─────────────
// Needs a running server (PORT from .env) and TEST_KEYFILE in .env. No tx is
// sent: every write is forced down a validation / ownership / state error so
// the sweep is free and safe to run any time. The TEST_KEYFILE wallet must own a
// provider with at least one plan (a long-lived fixture; the e2e cleans up its own).
//   node scripts/test-all-handlers.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';

const BASE = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3003}`;
let cookie = '';
let pass = 0; let fail = 0;
const H = () => ({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(cookie ? { Cookie: cookie } : {}) });
function capture(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = Object.fromEntries((cookie ? cookie.split('; ') : []).map((p) => p.split('=')));
  for (const sc of list) { const [pair] = sc.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i); const v = pair.slice(i + 1); if (v) jar[k] = v; else delete jar[k]; }
  cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function call(method, path, body, { noCsrf = false } = {}) {
  const headers = H(); if (noCsrf) delete headers['X-Requested-With'];
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  capture(r);
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: r.status, json, text };
}
async function check(name, method, path, body, expect, opts) {
  const r = await call(method, path, body, opts);
  const problems = [];
  if (expect.status !== undefined && r.status !== expect.status) problems.push(`status ${r.status}≠${expect.status}`);
  if (expect.json !== false && r.json === null) problems.push('non-JSON body');
  if (expect.errorCode && r.json?.errorCode !== expect.errorCode) problems.push(`errorCode ${r.json?.errorCode}≠${expect.errorCode}`);
  if (expect.has) for (const k of expect.has) if (!(r.json && k in r.json)) problems.push(`missing ${k}`);
  if (expect.fn) { try { const m = expect.fn(r.json, r); if (m) problems.push(m); } catch (e) { problems.push(e.message); } }
  if (problems.length) { fail++; console.log(`  ✗ ${name} — ${problems.join('; ')} ${JSON.stringify(r.json || r.text).slice(0, 160)}`); } else { pass++; console.log(`  ✓ ${name}`); }
  return r.json;
}

const key = readFileSync(process.env.TEST_KEYFILE, 'utf8');
const TEST_ADDRESS = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key))).publicKey.toBase58();
const rnd = () => Keypair.generate().publicKey.toBase58();
const t0 = Date.now();

console.log(`handlers @ ${BASE}`);
console.log('— public reads');
await check('GET /health', 'GET', '/health', undefined, { status: 200, has: ['status', 'network'] });
await check('GET /health/rpc', 'GET', '/health/rpc', undefined, { status: 200, has: ['serving', 'slot', 'pool'], fn: (j) => (/api-key=[^<]/.test(JSON.stringify(j)) ? 'api key leaked' : null) });
await check('GET /health/daemons (no session → no internal target)', 'GET', '/health/daemons', undefined, { status: 200, has: ['daemons'], fn: (j) => (j.daemons.some((d) => 'target' in d || 'error' in d) ? 'target leaked without a session' : null) });
await check('GET / carries the app shell', 'GET', '/', undefined, { status: 200, json: false, fn: (j, r) => (/class="shell"/.test(r.text) && /<aside class="sidebar"/.test(r.text) ? null : 'shell/sidebar markup missing') });
await check('GET /api/params', 'GET', '/api/params', undefined, { status: 200, fn: (j) => (j.config?.feeBps === 200 ? null : 'feeBps') });
await check('GET /api/providers?all=1', 'GET', '/api/providers?all=1', undefined, { status: 200, fn: (j) => (j.providers.length >= 1 ? null : 'no providers') });
await check('GET /api/plans', 'GET', '/api/plans', undefined, { status: 200, has: ['plans'] });
await check('GET /api/all-nodes', 'GET', '/api/all-nodes?limit=5', undefined, { status: 200, has: ['nodes', 'total', 'countries'] });
await check('GET /api/all-nodes filters', 'GET', '/api/all-nodes?country=ZZ&protocol=wireguard', undefined, { status: 200, fn: (j) => (j.total === 0 ? null : 'ZZ matched') });
await check('GET /api/nodes/chain-count', 'GET', '/api/nodes/chain-count', undefined, { status: 200, has: ['count', 'listed', 'live'] });
await check('GET /api/nodes/progress', 'GET', '/api/nodes/progress', undefined, { status: 200, has: ['total'] });
await check('GET /api/node-rankings', 'GET', '/api/node-rankings', undefined, { status: 200, has: ['cheapestLease'] });
await check('GET /api/price (devnet → null)', 'GET', '/api/price', undefined, { status: 200, has: ['usd'] });
const privyCfg = await check('GET /api/wallet/privy-config', 'GET', '/api/wallet/privy-config', undefined, { status: 200, has: ['enabled', 'chain'] });
await check('GET unknown → 404 JSON', 'GET', '/api/does-not-exist', undefined, { status: 404, errorCode: 'not-found' });
await check('POST unknown → 404 JSON', 'POST', '/api/does-not-exist', {}, { status: 404, errorCode: 'not-found' });
{
  const r = await fetch(BASE + '/api/wallet/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: '{bad json' });
  const j = await r.json().catch(() => null);
  if (r.status === 400 && j?.errorCode === 'bad-json') { pass++; console.log('  ✓ malformed JSON body → 400 bad-json'); } else { fail++; console.log(`  ✗ malformed JSON body → ${r.status} ${JSON.stringify(j)}`); }
}
await check('CSRF: POST without header/origin → 403', 'POST', '/api/wallet/logout', {}, { status: 403, errorCode: 'csrf' }, { noCsrf: true });

console.log('— fee grants (work in progress on Solana)');
await check('POST _clientlog accepts a client error report', 'POST', '/api/_clientlog', { level: 'warn', message: 'handler-sweep probe', stack: '' }, { status: 200, fn: (j) => (j.ok ? null : 'not ok') });
await check('POST _clientlog without the CSRF header → 403', 'POST', '/api/_clientlog', { message: 'x' }, { status: 403 }, { noCsrf: true });
await check('GET feegrant/grants → wip', 'GET', '/api/feegrant/grants', undefined, { status: 200, fn: (j) => (j.wip ? null : 'not wip') });
await check('GET feegrant/gas-costs → wip', 'GET', '/api/feegrant/gas-costs', undefined, { status: 200, fn: (j) => (j.wip ? null : 'not wip') });
await check('GET feegrant/auto-grant → wip', 'GET', '/api/feegrant/auto-grant', undefined, { status: 200, fn: (j) => (j.wip ? null : 'not wip') });
for (const p of ['grant', 'grant-subscribers', 'revoke', 'revoke-list', 'revoke-all', 'auto-grant']) await check(`POST feegrant/${p} → 501`, 'POST', `/api/feegrant/${p}`, {}, { status: 501, errorCode: 'not-on-solana-yet' });
await check('GET feegrant/grant-subscribers-stream → 501', 'GET', '/api/feegrant/grant-subscribers-stream', undefined, { status: 501 });

console.log('— unauthenticated writes/reads → 401');
for (const [m, p] of [['GET', '/api/wallet'], ['GET', '/api/my-plans'], ['GET', '/api/earnings'], ['GET', '/api/leases'], ['POST', '/api/plan/create'], ['POST', '/api/provider/register'], ['POST', '/api/plan-manager/link'], ['POST', '/api/tx/broadcast-signed'], ['POST', '/api/wallet/send']]) {
  await check(`${m} ${p} (no session)`, m, p, m === 'POST' ? {} : undefined, { status: 401, errorCode: 'wallet-required' });
}
await check('GET /api/wallet/status (logged out)', 'GET', '/api/wallet/status', undefined, { status: 200, fn: (j) => (j.loaded === false ? null : 'loaded') });

console.log('— login validation');
await check('import: missing key → 400', 'POST', '/api/wallet/import', {}, { status: 400, errorCode: 'missing-field' });
await check('import: garbage → 400', 'POST', '/api/wallet/import', { key: 'not a key' }, { status: 400 });
await check('import: bad JSON array → 400', 'POST', '/api/wallet/import', { key: '[1,2,3]' }, { status: 400, errorCode: 'invalid-key' });
await check('login: missing fields → 400', 'POST', '/api/wallet/login', { pubkey: rnd() }, { status: 400, errorCode: 'missing-field' });
await check('login: unknown challenge → 400', 'POST', '/api/wallet/login', { pubkey: rnd(), signature: 'AAAA', nonce: 'nope' }, { status: 400, errorCode: 'bad-challenge' });
const ch = await check('challenge issues a nonce', 'POST', '/api/wallet/challenge', {}, { status: 200, has: ['nonce'] });
await check('login: bad signature → 401', 'POST', '/api/wallet/login', { pubkey: rnd(), signature: Buffer.alloc(64).toString('base64'), nonce: ch.nonce }, { status: 401, errorCode: 'bad-signature' });
if (privyCfg?.enabled) {
  await check('privy-login: no token → 400', 'POST', '/api/wallet/privy-login', {}, { status: 400 });
  await check('privy-login: bad token → 401', 'POST', '/api/wallet/privy-login', { accessToken: 'nope' }, { status: 401, errorCode: 'privy-token' });
} else {
  await check('privy-login with Privy off → 503 privy-off', 'POST', '/api/wallet/privy-login', { accessToken: 'nope' }, { status: 503, errorCode: 'privy-off' });
}

console.log('— keypair session (test wallet) — reads');
await check('import test key', 'POST', '/api/wallet/import', { key }, { status: 200, fn: (j) => (j.address === TEST_ADDRESS ? null : 'wrong address') });
await check('GET /api/wallet/status (logged in)', 'GET', '/api/wallet/status', undefined, { status: 200, fn: (j) => (j.loaded && j.kind === 'keypair' ? null : 'not loaded') });
const wallet = await check('GET /api/wallet', 'GET', '/api/wallet', undefined, { status: 200, has: ['sol', 'tdvpn', 'provider'], fn: (j) => (Number(j.sol.amount) > 0 && Number(j.tdvpn.amount) > 0 ? null : 'unfunded') });
await check('GET /api/wallet/qr', 'GET', '/api/wallet/qr', undefined, { status: 200, fn: (j) => (j.dataUrl?.startsWith('data:image/png') ? null : 'no png') });
const prov = await check('GET /api/providers (owned)', 'GET', '/api/providers', undefined, { status: 200, fn: (j) => (j.active === wallet.provider ? null : 'active mismatch') });
await check('GET /api/providers/daemon', 'GET', '/api/providers/daemon', undefined, { status: 200, has: ['daemons', 'active'] });
await check('GET /api/provider/unbonding', 'GET', '/api/provider/unbonding', undefined, { status: 200, has: ['unbonding'] });
const mine = await check('GET /api/my-plans', 'GET', '/api/my-plans', undefined, { status: 200, fn: (j) => (Array.isArray(j.plans) && j.plans.length >= 1 ? null : 'no plans (the test wallet needs a fixture plan)') });
if (!mine?.plans?.length) { console.log(`handlers: ${pass} passed, ${fail} failed — stopped: ${TEST_ADDRESS} owns no plan`); process.exit(1); }
const plan = mine.plans.find((p) => !p.free && p.listed) || mine.plans[0];
await check('GET /api/plans/:id', 'GET', `/api/plans/${plan.address}`, undefined, { status: 200, fn: (j) => (j.address === plan.address ? null : 'mismatch') });
await check('GET /api/plans/:id (unknown) → 404', 'GET', `/api/plans/${rnd()}`, undefined, { status: 404, errorCode: 'plan-not-found' });
await check('GET /api/plans/:id (garbage) → 400', 'GET', '/api/plans/not-a-key', undefined, { status: 400, errorCode: 'invalid-address' });
await check('GET /api/plans/:id/subscriptions', 'GET', `/api/plans/${plan.address}/subscriptions`, undefined, { status: 200, has: ['subscriptions'] });
await check('GET /api/plans/:id/members', 'GET', `/api/plans/${plan.address}/members`, undefined, { status: 200, has: ['subscribers', 'nodes', 'rosterAvailable'] });
await check('GET /api/plans/:id/own-subscription', 'GET', `/api/plans/${plan.address}/own-subscription`, undefined, { status: 200, has: ['subscribed'] });
await check('GET /api/plans/:id/share', 'GET', `/api/plans/${plan.address}/share`, undefined, { status: 200, fn: (j) => (j.share?.command?.includes('open-subscription') ? null : 'no command') });
await check('GET /api/leases', 'GET', '/api/leases', undefined, { status: 200, has: ['leases', 'daemonAvailable'] });
await check('GET /api/earnings', 'GET', '/api/earnings', undefined, { status: 200, has: ['provider', 'user', 'unbonding'] });
await check('GET /api/all-nodes?planId (roster flags)', 'GET', `/api/all-nodes?planId=${plan.address}&limit=5`, undefined, { status: 200, fn: (j) => ('rosterAvailable' in j ? null : 'no roster flag') });

console.log('— keypair session — writes forced down error branches (no spend)');
await check('plan/create: missing duration → 400', 'POST', '/api/plan/create', { priceTdvpn: '1' }, { status: 400, errorCode: 'missing-field' });
await check('plan/create: duration too short → 400', 'POST', '/api/plan/create', { durationSeconds: 5 }, { status: 400, errorCode: 'invalid-field' });
await check('plan/create: 7-decimal price → 400', 'POST', '/api/plan/create', { priceTdvpn: '1.1234567', durationSeconds: 3600 }, { status: 400, errorCode: 'invalid-field' });
await check('plan/create: maxConnections 0 → 400', 'POST', '/api/plan/create', { durationSeconds: 3600, maxConnections: 0 }, { status: 400, errorCode: 'invalid-field' });
// Regression (audit 2026-10-14): "-5" used to open a plan priced 5; "abc"/"1.5" and > u64 were 500s.
for (const price of ['-5', 'abc', '1.5', '18446744073709551616']) {
  await check(`plan/create: base-unit price "${price}" → 400`, 'POST', '/api/plan/create', { price, durationSeconds: 3600 }, { status: 400, errorCode: 'invalid-field' });
}
await check('plan/create: tDVPN price above u64 → 400', 'POST', '/api/plan/create', { priceTdvpn: '99999999999999999', durationSeconds: 3600 }, { status: 400, errorCode: 'invalid-field' });
await check('plan/create: hex duration → 400', 'POST', '/api/plan/create', { durationSeconds: '0xe10' }, { status: 400, errorCode: 'invalid-field' });
await check('plan/create: boolean maxConnections → 400', 'POST', '/api/plan/create', { durationSeconds: 3600, maxConnections: true }, { status: 400, errorCode: 'invalid-field' });
await check('tx/broadcast-signed: garbage tx → 400 invalid-tx', 'POST', '/api/tx/broadcast-signed', { tx: 'zzzz' }, { status: 400, errorCode: 'invalid-tx' });
await check('plan/update: unknown plan → 404', 'POST', '/api/plan/update', { planId: rnd(), dataCapGb: 5 }, { status: 404, errorCode: 'plan-not-found' });
await check('plan/update: nothing to update → 400', 'POST', '/api/plan/update', { planId: plan.address }, { status: 400, errorCode: 'missing-field' });
await check('plan/status: bad status → 400', 'POST', '/api/plan/status', { planId: plan.address, status: 7 }, { status: 400, errorCode: 'invalid-field' });
await check('plan/status: same status → unchanged (no tx)', 'POST', '/api/plan/status', { planId: plan.address, status: plan.listed ? 1 : 0 }, { status: 200, fn: (j) => (j.unchanged ? null : 'sent a tx') });
await check('plan/close: garbage id → 400', 'POST', '/api/plan/close', { planId: 'zzz' }, { status: 400, errorCode: 'invalid-address' });
const foreignPlan = (await call('GET', '/api/plans')).json.plans.find((p) => p.provider !== wallet.provider);
if (foreignPlan) await check('plan/status on another provider\'s plan → 403', 'POST', '/api/plan/status', { planId: foreignPlan.address, status: 0 }, { status: 403, errorCode: 'not-plan-owner' });
else { pass++; console.log('  ✓ (no foreign plan on devnet to test 403 against — skipped)'); }
await check('provider/register: missing uri → 400', 'POST', '/api/provider/register', {}, { status: 400, errorCode: 'missing-field' });
await check('provider/register: http:// → 400', 'POST', '/api/provider/register', { uri: 'http://x' }, { status: 400, errorCode: 'invalid-field' });
// A delisted provider would be LISTED by this call (a real tx), so the no-tx check only runs when it is listed.
if (prov.providers[0].listed) await check('provider/register: same uri → unchanged (no tx)', 'POST', '/api/provider/register', { uri: prov.providers[0].uri }, { status: 200, fn: (j) => (j.unchanged ? null : 'sent a tx') });
else console.log('  - provider is delisted: skipping the same-uri no-tx check (it would relist)');
await check('provider/status: bad → 400', 'POST', '/api/provider/status', { status: 5 }, { status: 400 });
await check('provider/select: not owned → 403', 'POST', '/api/provider/select', { provider: rnd() }, { status: 403, errorCode: 'not-provider-owner' });
await check('provider/close with open plans → 409', 'POST', '/api/provider/close', {}, { status: 409, errorCode: 'open-plans-remain' });
await check('provider/withdraw-bond: nothing parked → 404', 'POST', '/api/provider/withdraw-bond', {}, { status: 404, errorCode: 'no-unbonding' });
await check('link: missing planId → 400', 'POST', '/api/plan-manager/link', { nodeAddress: rnd() }, { status: 400 });
await check('link: unknown plan → 404', 'POST', '/api/plan-manager/link', { planId: rnd(), nodeAddress: rnd() }, { status: 404, errorCode: 'plan-not-found' });
await check('link: no nodes → 400', 'POST', '/api/plan-manager/batch-link', { planId: plan.address, nodeAddresses: [] }, { status: 400, errorCode: 'missing-field' });
await check('link: >100 nodes → 400', 'POST', '/api/plan-manager/batch-link', { planId: plan.address, nodeAddresses: Array.from({ length: 101 }, rnd) }, { status: 400, errorCode: 'batch-too-large' });
await check('link: node not on chain → daemon 404', 'POST', '/api/plan-manager/link', { planId: plan.address, nodeAddress: rnd() }, { status: 404 });
await check('unlink: unknown plan → 404', 'POST', '/api/plan-manager/unlink', { planId: rnd(), nodeAddress: rnd() }, { status: 404, errorCode: 'plan-not-found' });
await check('batch-unlink: no nodes → 400', 'POST', '/api/plan-manager/batch-unlink', { planId: plan.address, nodeAddresses: [] }, { status: 400, errorCode: 'missing-field' });
await check('subscribe: unknown plan → 404', 'POST', '/api/plan/subscribe', { planId: rnd() }, { status: 404, errorCode: 'plan-not-found' });
await check('add-subscriber: bad address → 400', 'POST', '/api/plan/add-subscriber', { planId: plan.address, address: 'nope' }, { status: 400, errorCode: 'invalid-address' });
await check('add-subscriber: program-derived address → 400 not-a-wallet', 'POST', '/api/plan/add-subscriber', { planId: plan.address, address: 'Cu5vofxVQgZXRVwfBqApw84ZWy1hjhDmHkznyDr6TRiQ' }, { status: 400, errorCode: 'not-a-wallet' });
await check('add-subscribers: every rejected input is reported with its reason', 'POST', '/api/plan/add-subscribers', { planId: plan.address, addresses: ['nope', 'Cu5vofxVQgZXRVwfBqApw84ZWy1hjhDmHkznyDr6TRiQ'] }, { status: 400, fn: (j) => (j.invalid?.length === 2 && j.invalid.some((x) => x.errorCode === 'not-a-wallet') && j.invalid.some((x) => x.errorCode === 'invalid-address') ? null : 'invalid list incomplete') });
await check('plan read with a NODE address → 400 wrong-account-type (not 500)', 'GET', '/api/plans/6AaXvhWpFDMf8FimxSb2Tb3bKcgPmbZxj4Tdtb31nP8F', undefined, { status: 400, errorCode: 'wrong-account-type' });
await check('close-subscription with a PLAN address → 400 wrong-account-type', 'POST', '/api/plan/close-subscription', { subscription: plan.address }, { status: 400, errorCode: 'wrong-account-type' });
await check('lease/end with a NODE address → 400 wrong-account-type', 'POST', '/api/lease/end', { lease: '6AaXvhWpFDMf8FimxSb2Tb3bKcgPmbZxj4Tdtb31nP8F' }, { status: 400, errorCode: 'wrong-account-type' });
if (plan.free) console.log('  - no priced plan owned: skipping the priced-plan share check');
if (!plan.free) await check('add-subscriber on a PRICED plan → 400 self-subscribe + share', 'POST', '/api/plan/add-subscriber', { planId: plan.address, address: rnd() }, { status: 400, errorCode: 'subscriber-must-self-subscribe', has: ['share', 'needSubscription'] });
await check('add-subscribers: empty → 400', 'POST', '/api/plan/add-subscribers', { planId: plan.address, addresses: [] }, { status: 400, errorCode: 'missing-field' });
await check('add-subscribers: all invalid → 400', 'POST', '/api/plan/add-subscribers', { planId: plan.address, addresses: ['a', 'b'] }, { status: 400, errorCode: 'invalid-address' });
// MAX_BATCH_ADDRESSES boundary: 61 is refused before any validation; 60 passes the cap (and fails on the addresses, spending nothing).
await check('add-subscribers: 60 bad addresses → passes the cap, 400 invalid-address', 'POST', '/api/plan/add-subscribers', { planId: plan.address, addresses: Array.from({ length: 60 }, () => 'nope') }, { status: 400, errorCode: 'invalid-address' });
await check('add-subscribers: 61 → 400 batch-too-large', 'POST', '/api/plan/add-subscribers', { planId: plan.address, addresses: Array.from({ length: 61 }, rnd) }, { status: 400, errorCode: 'batch-too-large' });
await check('close-subscription: unknown → 404', 'POST', '/api/plan/close-subscription', { subscription: rnd() }, { status: 404, errorCode: 'subscription-not-found' });
await check('request-ticket without a usable subscription → 409', 'POST', '/api/plan/request-ticket', { planId: plan.address, node: rnd() }, { status: 409, fn: (j) => (['not-subscribed', 'subscription-expired'].includes(j.errorCode) ? null : `errorCode ${j.errorCode}`) });
await check('lease/end: unknown lease → 404', 'POST', '/api/lease/end', { lease: rnd() }, { status: 404, errorCode: 'lease-not-found' });
// Closed leases return their unspent escrow to the provider balance, so it is not always empty.
// Drain it first (to our own wallet), then the empty case must refuse.
const freshProv = await check('GET /api/providers?fresh=1', 'GET', '/api/providers?fresh=1', undefined, { status: 200, has: ['providers', 'active'] });
const activeProvider = (freshProv?.providers || []).find((p) => p.address === freshProv?.active);
if (activeProvider && BigInt(activeProvider.balance || 0) > 0n) {
  await check(`earnings/withdraw-balance: ${activeProvider.balanceTdvpn ?? activeProvider.balance} → 200`, 'POST', '/api/earnings/withdraw-balance', {}, { status: 200, has: ['txHash'] });
}
await check('earnings/withdraw-balance: empty → 409', 'POST', '/api/earnings/withdraw-balance', {}, { status: 409, errorCode: 'nothing-to-withdraw' });
await check('earnings/withdraw-user-balance: empty → 409', 'POST', '/api/earnings/withdraw-user-balance', {}, { status: 409, errorCode: 'nothing-to-withdraw' });
await check('earnings/withdraw-revenue: more than available → 400', 'POST', '/api/earnings/withdraw-revenue', { amount: '999999' }, { status: 400, errorCode: 'insufficient-revenue' });
await check('wallet/send: bad address → 400', 'POST', '/api/wallet/send', { to: 'nope', amount: '1' }, { status: 400, errorCode: 'invalid-address' });
await check('wallet/send: bad asset → 400', 'POST', '/api/wallet/send', { to: rnd(), amount: '1', asset: 'BTC' }, { status: 400, errorCode: 'invalid-field' });
await check('wallet/send: zero amount → 400', 'POST', '/api/wallet/send', { to: rnd(), amount: '0', asset: 'SOL' }, { status: 400, errorCode: 'invalid-field' });
// Regression (audit 2026-10-14): "0x10" was read as 16 SOL.
for (const amount of ['0x10', '1e3', '-1', '0.0000000001']) {
  await check(`wallet/send: SOL amount "${amount}" → 400`, 'POST', '/api/wallet/send', { to: rnd(), amount, asset: 'SOL' }, { status: 400, errorCode: 'invalid-field' });
}
await check('wallet/send: more SOL than held → 400 insufficient SOL', 'POST', '/api/wallet/send', { to: rnd(), amount: '1000000', asset: 'SOL' }, { status: 400, fn: (j) => (/not enough SOL/i.test(j?.error || '') && !/tDVPN/.test(j?.error || '') ? null : `error "${j?.error}"`) });
await check('broadcast-signed: missing tx → 400', 'POST', '/api/tx/broadcast-signed', {}, { status: 400, errorCode: 'missing-field' });
await check('logout', 'POST', '/api/wallet/logout', {}, { status: 200 });
await check('status after logout', 'GET', '/api/wallet/status', undefined, { status: 200, fn: (j) => (j.loaded === false ? null : 'still loaded') });

console.log(`\nhandlers: ${pass} passed, ${fail} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(fail ? 1 : 0);
