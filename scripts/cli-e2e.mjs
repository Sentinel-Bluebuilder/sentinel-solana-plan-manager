#!/usr/bin/env node
// ─── END-TO-END: every function, from the operator's AND the subscriber's seat ──
// Drives `node cli.js … --json` against a running server on live devnet.
//
//   operator    the owner-approved funded test wallet (TEST_KEYFILE in .env)
//   subscriber  a fresh wallet this run funds from the operator, uses as a real
//               third-party customer, then drains back (SOL and tDVPN) at the end
//
// Every write is verified INDEPENDENTLY: the account is read straight from the
// RPC and decoded here, not taken from the console's own answer. Balances are
// checked as exact deltas. Real transactions, 7 s apart. Everything the run
// creates it closes again, in a finally block if a step fails.
//
//   node scripts/cli-e2e.mjs        exit 0 = every step passed · 1 = a step failed
//                                   2 = steps were SKIPPED (no daemon); E2E_ALLOW_SKIP=1 accepts that as 0
//
// Prerequisites: node server.js; WSL rig up (scripts/dev/wsl-up.sh) for the
// roster / lease / ticket steps — without a daemon those steps report SKIP.
// If a run dies mid-way, the subscriber key stays in test/.e2e-subscriber.json
// (gitignored) and the next run reuses it, so its funds are never stranded.
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createCloseAccountInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { decodeAccount, tdvpn } from '../lib/solana/accounts.js';
import { MINT, loadIdl } from '../lib/solana/idl.js';
import { BorshEventCoder } from '@coral-xyz/anchor';
import { rpcCall, sendConnection, getRpcCounters } from '../lib/solana/rpc.js';

const BASE = String(process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3003}`).replace(/\/$/, '');

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const CLI = join(ROOT, 'cli.js');
const SESSIONS = { op: join(ROOT, '.cli-e2e-session.json'), sub: join(ROOT, 'test', '.e2e-sub-session.json') };
const SUB_KEYFILE = join(ROOT, 'test', '.e2e-subscriber.json');
const LOG = join(ROOT, 'test', 'cli-e2e-last-run.log');
const NODE = process.env.E2E_NODE || '6AaXvhWpFDMf8FimxSb2Tb3bKcgPmbZxj4Tdtb31nP8F';
const CONFIG_PDA = 'Cu5vofxVQgZXRVwfBqApw84ZWy1hjhDmHkznyDr6TRiQ'; // off-curve: never a wallet
const GAP_MS = 7000;
const SUB_SOL = 0.03;
const SUB_TDVPN = '0.005';
const PRICE = '0.001'; // 1000 base units
const PRICED_DURATION = 90;
const results = [];
const lines = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => { console.log(s); lines.push(s); };

// ─── independent chain reads (not through the console) ──────────────────────
// The suite's own reads go through the console's RPC pool (lib/solana/rpc.js): same
// failover, same ≤5 req/s pacing, same 429 back-off, and counted for the run report.
const conn = {
  getAccountInfo: (pk, c = 'confirmed') => rpcCall((x) => x.getAccountInfo(pk, c), { label: 'e2e:account' }),
  getTokenAccountBalance: (pk, c = 'confirmed') => rpcCall((x) => x.getTokenAccountBalance(pk, c), { label: 'e2e:token' }),
  getBalance: (pk, c = 'confirmed') => rpcCall((x) => x.getBalance(pk, c), { label: 'e2e:balance' }),
  getTransaction: (sig, o) => rpcCall((x) => x.getTransaction(sig, o), { label: 'e2e:tx' }),
};
await rpcCall((x) => x.getSlot('confirmed'), { label: 'e2e:slot' });
async function onChain(name, addr) {
  const info = await conn.getAccountInfo(new PublicKey(addr), 'confirmed');
  return info ? decodeAccount(name, info.data) : null;
}
async function tokenBase(owner) {
  const a = getAssociatedTokenAddressSync(MINT, new PublicKey(owner), true, TOKEN_2022_PROGRAM_ID);
  return tokenAccountBase(a);
}
async function tokenAccountBase(addr) {
  try {
    return BigInt((await conn.getTokenAccountBalance(new PublicKey(addr), 'confirmed')).value.amount);
  } catch (e) {
    if (/could not find account|Invalid param/i.test(e.message)) return null;
    throw e;
  }
}
const lamports = (a) => conn.getBalance(new PublicKey(a), 'confirmed');

// The test wallet is shared with other projects' suites (Node Manager,
// Launchpad), and the vault and treasury are shared by everyone, so a
// before/after balance read can include someone else's transaction landing in
// between. Exact amounts are therefore asserted from the transaction's OWN
// recorded pre/post balances, which nothing else can disturb.
async function txMeta(sig) {
  for (let i = 0; i < 8; i++) {
    const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (t) return t;
    await sleep(2000); // fleet rule: status polls ≥ 2 s apart
  }
  throw new Error(`tx ${sig} not found on chain`);
}
function keyIndex(t, addr) { return t.transaction.message.staticAccountKeys.findIndex((k) => k.toBase58() === addr); }
/** tDVPN base-unit change in one tx, for a token ACCOUNT address or a wallet OWNER. */
async function txTokenDelta(sig, { account, owner }) {
  const t = await txMeta(sig);
  const keys = t.transaction.message.staticAccountKeys;
  const pick = (list) => (list || []).filter((b) => b.mint === MINT.toBase58() && (account ? keys[b.accountIndex].toBase58() === account : b.owner === owner));
  const sum = (list) => pick(list).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(t.meta.postTokenBalances) - sum(t.meta.preTokenBalances);
}
async function txLamportDelta(sig, addr) {
  const t = await txMeta(sig); const i = keyIndex(t, addr);
  if (i < 0) return 0;
  return t.meta.postBalances[i] - t.meta.preBalances[i];
}
async function txFee(sig) { return (await txMeta(sig)).meta.fee; }

// ─── LeaseFunded events (the provider daemon's lease top-ups) ────────────────
// The program draws a lease top-up from the provider's balance, then its revenue,
// then the owner's wallet (lease.rs draw_from_pools) and emits LeaseFunded with
// each part. Read from the tx logs, so no other suite's traffic can disturb them.
const eventCoder = new BorshEventCoder(loadIdl());
// The fork-cb33-4 daemon sends version-1 transactions, which web3.js cannot decode,
// so its txs are fetched as raw JSON: log lines and token balances are all we need.
async function txRawMeta(sig) {
  for (let i = 0; i < 8; i++) {
    const res = await rpcCall((x) => x._rpcRequest('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]), { label: 'e2e:tx-raw' });
    if (res.error) throw new Error(`getTransaction ${sig}: ${res.error.message}`);
    if (res.result) return res.result;
    await sleep(2000); // fleet rule: status polls ≥ 2 s apart
  }
  throw new Error(`tx ${sig} not found on chain`);
}
function rawOwnerDelta(t, owner) {
  const sum = (list) => (list || []).filter((b) => b.mint === MINT.toBase58() && b.owner === owner).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(t.meta.postTokenBalances) - sum(t.meta.preTokenBalances);
}
const big = (v) => BigInt(v?.toString?.() ?? v ?? 0);
const field = (d, snake, camel) => big(d[snake] ?? d[camel]);
async function leaseFundedSince(lease, minSlot) {
  const sigs = await rpcCall((x) => x.getSignaturesForAddress(new PublicKey(lease), { limit: 50 }, 'confirmed'), { label: 'e2e:sigs' });
  const out = [];
  for (const s of sigs.filter((x) => !x.err && x.slot >= minSlot).reverse()) {
    const t = await txRawMeta(s.signature);
    for (const line of t.meta.logMessages || []) {
      if (!line.startsWith('Program data: ')) continue;
      const ev = eventCoder.decode(line.slice('Program data: '.length));
      if (!ev || !/^lease_?funded$/i.test(ev.name)) continue;
      const d = ev.data;
      out.push({
        sig: s.signature, slot: s.slot, ownerDelta: (owner) => rawOwnerDelta(t, owner),
        amount: field(d, 'amount', 'amount'),
        fromBalance: field(d, 'from_balance', 'fromBalance'),
        fromRevenue: field(d, 'from_revenue', 'fromRevenue'),
        providerBalance: field(d, 'provider_balance', 'providerBalance'),
        providerRevenue: field(d, 'provider_revenue', 'providerRevenue'),
      });
    }
  }
  return out;
}

// ─── CLI driver ──────────────────────────────────────────────────────────────
// The rpc-gate answers busy (429 → our 500 "RPC is busy") when a burst passes its per-client cap.
// One retry after 6 s covers it, for READ commands only: a write may have sent its tx before
// it saw busy, so a write is never retried. A second busy is a real failure.
const BUSY = /RPC is busy/i;
// Exact read-only commands (plan/provider status are WRITES: they list or delist).
const READS = new Set(['health', 'wallet status', 'wallet balance', 'earnings show', 'nodes list', 'plan list',
  'plan members', 'provider list', 'provider unbonding', 'subscriber own', 'feegrant status']);
const isRead = (args) => READS.has(args[0]) || READS.has(`${args[0]} ${args[1] || ''}`);
function cli(args, { allowFail = false, ...opts } = {}) {
  let r = cliOnce(args, opts);
  if (!r.ok && isRead(args) && BUSY.test(JSON.stringify(r.json) + r.stderr)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
    r = cliOnce(args, opts);
  }
  if (!r.ok && !allowFail) throw new Error(`cli ${args.join(' ')} failed: ${r.json ? JSON.stringify(r.json).slice(0, 300) : r.stderr.slice(0, 300)}`);
  return r;
}
function cliOnce(args, { as = 'op' } = {}) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args, '--json', '--session', SESSIONS[as]], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
    return { ok: true, json: JSON.parse(out) };
  } catch (e) {
    const stdout = e.stdout ? String(e.stdout) : '';
    let json = null; try { json = JSON.parse(stdout); } catch (err) { json = null; }
    // The caller (cli) says what the server said, e.g. an RPC rate limit, when a must-succeed call fails.
    return { ok: false, json, stderr: String(e.stderr || e.message || '') };
  }
}
let n = 0;
async function step(name, fn, { write = false } = {}) {
  n++;
  const id = `S${String(n).padStart(2, '0')}`;
  try {
    const detail = await fn();
    results.push({ id, name, ok: true }); say(`  PASS ${id} ${name}${detail ? '  — ' + detail : ''}`);
  } catch (e) {
    if (e.skip) { results.push({ id, name, ok: true, skip: true }); say(`  SKIP ${id} ${name} — ${e.message}`); }
    else { results.push({ id, name, ok: false, error: e.message }); say(`  FAIL ${id} ${name} — ${e.message}`); }
  }
  if (write) await sleep(GAP_MS);
}
const skip = (msg) => { const e = new Error(msg); e.skip = true; return e; };
const must = (c, msg) => { if (!c) throw new Error(msg); };
const eq = (a, b, what) => must(String(a) === String(b), `${what}: got ${a}, want ${b}`);
const refused = (r, codes) => must(!r.ok && codes.includes(r.json?.errorCode), `expected ${codes.join('|')}, got ${JSON.stringify(r.json).slice(0, 220)}`);
const rnd = () => Keypair.generate().publicKey.toBase58();
const daemonOnly = () => { if (!state.daemon) throw skip('no provider daemon for the active provider'); };

const state = {
  op: null, sub: null, provider: null, vault: null, treasury: null, daemon: false,
  freePlan: null, pricedPlan: null, linked: new Set(), subs: new Map(), subFunded: false, lease: null,
};
const trackSub = (addr, closer) => state.subs.set(addr, closer);
const untrackSub = (addr) => state.subs.delete(addr);

// The subscriber key: reuse a stranded one from a crashed run, else make one.
let subKp;
if (existsSync(SUB_KEYFILE)) subKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(SUB_KEYFILE, 'utf8'))));
else { subKp = Keypair.generate(); mkdirSync(dirname(SUB_KEYFILE), { recursive: true }); writeFileSync(SUB_KEYFILE, JSON.stringify(Array.from(subKp.secretKey)), 'utf8'); }
state.sub = subKp.publicKey.toBase58();

say(`cli-e2e · ${new Date().toISOString()} · node ${NODE} · subscriber ${state.sub}`);
try {
  // ─── preflight ─────────────────────────────────────────────────────────────
  say('— preflight');
  await step('health', () => { const r = cli(['health', 'show']); must(r.json.status === 'ok', 'health'); return `network=${r.json.network}`; });
  await step('rpc pool healthy', () => { const r = cli(['rpc', 'show']); must(r.json.slot > 0, 'no slot'); must(!/api-key=[^<]/.test(JSON.stringify(r.json)), 'rpc key leaked'); return `slot ${r.json.slot} via ${r.json.serving}`; });
  await step('params decode = chain config', async () => {
    const r = cli(['params', 'show']); const c = await onChain('config', CONFIG_PDA);
    eq(r.json.config.feeBps, c.feeBps, 'feeBps'); eq(r.json.config.vault, c.vault, 'vault'); eq(r.json.config.minProviderBond, c.minProviderBond, 'minProviderBond');
    state.vault = c.vault; state.treasury = c.treasury; state.feeBps = Number(c.feeBps);
    return `feeBps ${c.feeBps}, vault ${c.vault.slice(0, 8)}…, treasury ${c.treasury.slice(0, 8)}…`;
  });
  await step('price endpoint (devnet → no market price)', () => { const r = cli(['params', 'price']); must(r.json.usd === null, 'devnet should have no price'); });
  await step('daemon health list', () => { const r = cli(['health', 'daemons']); must(Array.isArray(r.json.daemons), 'daemons'); return `${r.json.daemons.length} configured`; });
  await step('privy config', () => { const r = cli(['wallet', 'privy-config']); must(typeof r.json.enabled === 'boolean' && r.json.chain === 'solana', 'privy-config'); return `enabled=${r.json.enabled}`; });

  // ─── operator wallet ───────────────────────────────────────────────────────
  say('— operator wallet');
  await step('import test key', () => { const r = cli(['wallet', 'import', '--file', process.env.TEST_KEYFILE]); must(r.json.ok && r.json.mode === 'keypair', 'import'); state.op = r.json.address; return state.op; });
  await step('status loaded', () => { const r = cli(['wallet', 'status']); must(r.json.loaded && r.json.kind === 'keypair' && r.json.address === state.op, 'not loaded'); });
  await step('balance = chain (SOL lamports + tDVPN base units)', async () => {
    // Bracket the console read with chain reads; another suite's tx may land in between, so retry.
    let r; let sol; let tok; let matched = false;
    for (let i = 0; i < 4 && !matched; i++) {
      if (i) await sleep(16_000); // past the console's 15 s balance cache
      const [s0, t0] = [await lamports(state.op), await tokenBase(state.op)];
      r = cli(['wallet', 'balance']);
      [sol, tok] = [await lamports(state.op), await tokenBase(state.op)];
      matched = [s0, sol].map(String).includes(String(r.json.sol.lamports)) && [t0, tok].map(String).includes(String(r.json.tdvpn.baseUnits));
    }
    must(matched, `console ${r.json.sol.lamports} lamports / ${r.json.tdvpn.baseUnits} tDVPN vs chain ${sol} / ${tok}`);
    must(sol > 0.2e9 && tok > 1_000_000n, 'operator wallet underfunded');
    return `${r.json.sol.amount} SOL · ${r.json.tdvpn.amount} tDVPN`;
  });
  await step('qr', () => { const r = cli(['wallet', 'qr']); must(r.json.dataUrl.startsWith('data:image/png') && r.json.address === state.op, 'qr'); });
  await step('generate a throwaway keypair session, then re-import the test key', () => {
    const g = cli(['wallet', 'generate']); must(g.json.ok && g.json.secretKey.length === 64, 'generate');
    eq(Keypair.fromSecretKey(Uint8Array.from(g.json.secretKey)).publicKey.toBase58(), g.json.address, 'returned secret matches address');
    eq(cli(['wallet', 'status']).json.address, g.json.address, 'session switched');
    must(cli(['wallet', 'import', '--file', process.env.TEST_KEYFILE]).json.ok, 're-import');
    return g.json.address;
  });
  await step('send 0.0001 SOL to self (fee only leaves the wallet)', async () => {
    const r = cli(['wallet', 'send', '--to', state.op, '--amount', '0.0001', '--asset', 'SOL']); must(r.json.ok && r.json.txHash, 'send');
    const spent = -(await txLamportDelta(r.json.txHash, state.op)); eq(spent, await txFee(r.json.txHash), 'wallet change = tx fee');
    return `fee ${spent} lamports · ${r.json.txHash}`;
  }, { write: true });
  await step('send 0.001 tDVPN to self (Token-2022 transferChecked, balance unchanged)', async () => {
    const r = cli(['wallet', 'send', '--to', state.op, '--amount', '0.001', '--asset', 'TDVPN']); must(r.json.ok, 'send');
    eq(await txTokenDelta(r.json.txHash, { owner: state.op }), 0n, 'tDVPN change in the self-send tx'); return r.json.txHash;
  }, { write: true });

  // ─── subscriber wallet: funded from the operator, a separate customer ──────
  say('— subscriber wallet (a second, real customer)');
  await step(`fund subscriber with ${SUB_SOL} SOL (exact delta on chain)`, async () => {
    const before = await lamports(state.sub);
    const r = cli(['wallet', 'send', '--to', state.sub, '--amount', String(SUB_SOL), '--asset', 'SOL']); must(r.json.ok, 'send');
    state.subFunded = true;
    eq((await lamports(state.sub)) - before, SUB_SOL * 1e9, 'subscriber lamports delta');
    eq(await txLamportDelta(r.json.txHash, state.op), -(SUB_SOL * 1e9) - await txFee(r.json.txHash), 'operator paid amount + fee'); return r.json.txHash;
  }, { write: true });
  await step(`fund subscriber with ${SUB_TDVPN} tDVPN (creates its token account)`, async () => {
    const before = (await tokenBase(state.sub)) ?? 0n;
    const r = cli(['wallet', 'send', '--to', state.sub, '--amount', SUB_TDVPN, '--asset', 'TDVPN']); must(r.json.ok, 'send');
    eq((await tokenBase(state.sub)) - before, 5000n, 'subscriber tDVPN delta'); eq(await txTokenDelta(r.json.txHash, { owner: state.op }), -5000n, 'operator tDVPN delta in the tx');
    return r.json.txHash;
  }, { write: true });
  await step('subscriber signs in with its own key (second session)', () => {
    const r = cli(['wallet', 'import', '--file', SUB_KEYFILE], { as: 'sub' }); eq(r.json.address, state.sub, 'subscriber session address');
    const b = cli(['wallet', 'balance'], { as: 'sub' }); must(Number(b.json.tdvpn.baseUnits) >= 5000, 'subscriber balance via console');
    return `${b.json.sol.amount} SOL · ${b.json.tdvpn.amount} tDVPN`;
  });
  await step('subscriber owns no provider', () => { const r = cli(['provider', 'list'], { as: 'sub' }); must(r.json.active === null && r.json.providers.length === 0, 'subscriber has a provider?'); });

  // ─── provider ──────────────────────────────────────────────────────────────
  say('— provider');
  await step('provider list → active provider = chain', async () => {
    const r = cli(['provider', 'list']); must(r.json.active, 'no provider owned — register one first (bond 1 tDVPN)');
    state.provider = r.json.active; const p = await onChain('provider', state.provider);
    eq(p.owner, state.op, 'provider owner'); state.providerUri = p.uri;
    return `${state.provider} listed=${p.status === 1} uri=${p.uri}`;
  });
  await step('provider daemon reachable + serves the active provider', () => {
    const r = cli(['provider', 'daemon']);
    if (!r.json.activeDaemon || !r.json.activeDaemon.ok) throw skip(`no daemon for the active provider (${r.json.activeDaemon?.error || 'not configured'})`);
    eq(r.json.activeDaemon.info.address, state.provider, 'daemon provider');
    state.daemon = true; return `${r.json.activeDaemon.target} v${r.json.activeDaemon.version?.version?.tag || '?'}`;
  });
  await step('provider register (same uri) is a no-op', () => { const r = cli(['provider', 'register', '--uri', state.providerUri]); must(r.json.unchanged, 'sent a tx for an unchanged uri'); });
  await step('provider register rejects a non-https uri', () => refused(cli(['provider', 'register', '--uri', 'http://example.com'], { allowFail: true }), ['invalid-field']));
  await step('provider uri update lands on chain', async () => {
    const alt = state.providerUri.replace(/:(\d+)$/, (m, p) => `:${Number(p) + 1}`);
    must(alt !== state.providerUri, 'could not derive an alternate uri');
    const r = cli(['provider', 'register', '--uri', alt]); must(r.json.ok && !r.json.registered, 'update'); state.uriDirty = true;
    eq((await onChain('provider', state.provider)).uri, alt, 'uri on chain'); return `${alt} · ${r.json.txHash}`;
  }, { write: true });
  await step('provider uri restored', async () => {
    const r = cli(['provider', 'register', '--uri', state.providerUri]); must(r.json.ok, 'restore'); state.uriDirty = false;
    eq((await onChain('provider', state.provider)).uri, state.providerUri, 'uri on chain'); return r.json.txHash;
  }, { write: true });
  await step('provider select (own)', () => { const r = cli(['provider', 'select', state.provider]); must(r.json.ok && r.json.active === state.provider, 'select'); });
  await step('provider select of a provider this wallet does not own → 403', () => {
    const others = cli(['provider', 'list', '--all']).json.providers.filter((p) => p.owner !== state.op);
    const target = others[0]?.address || rnd(); // any address this wallet does not own
    refused(cli(['provider', 'select', target], { allowFail: true }), ['not-provider-owner']);
  });
  await step('provider unbonding list (empty while registered)', () => { const r = cli(['provider', 'unbonding']); must(Array.isArray(r.json.unbonding), 'unbonding'); return `${r.json.unbonding.length} parked`; });
  await step('provider withdraw-bond with nothing parked → 404', () => {
    // A matured parked bond would make this a REAL withdrawal: only run the refusal when nothing is parked.
    const parked = cli(['provider', 'unbonding']).json.unbonding;
    if (parked.length) throw skip(`${parked.length} parked bond(s) exist — the refusal path would withdraw for real`);
    refused(cli(['provider', 'withdraw-bond'], { allowFail: true }), ['no-unbonding']);
  });
  await step('provider delist → status 0 on chain', async () => { const r = cli(['provider', 'status', '--delisted']); must(r.json.ok, 'delist'); state.delisted = true; eq((await onChain('provider', state.provider)).status, 0, 'status'); return r.json.txHash; }, { write: true });
  await step('plan create refused while the provider is delisted', () => refused(cli(['plan', 'create', '--duration', '3600'], { allowFail: true }), ['provider-not-listed']));
  await step('provider relist → status 1 on chain', async () => { const r = cli(['provider', 'status']); must(r.json.ok, 'list'); state.delisted = false; eq((await onChain('provider', state.provider)).status, 1, 'status'); return r.json.txHash; }, { write: true });

  // ─── free plan lifecycle ───────────────────────────────────────────────────
  say('— free plan lifecycle');
  await step('create free plan (open+list, one tx) — terms on chain', async () => {
    const r = cli(['plan', 'create', '--duration', '3600', '--cap', '1', '--max', '1']); must(r.json.ok && r.json.planId, 'create'); state.freePlan = r.json.planId;
    const p = await onChain('plan', state.freePlan);
    eq(p.provider, state.provider, 'provider'); eq(p.price, 0, 'price'); eq(p.durationSeconds, 3600, 'duration'); eq(p.dataCapGb, 1, 'cap'); eq(p.maxConnections, 1, 'max'); eq(p.status, 1, 'status');
    return `${state.freePlan} tx ${r.json.txHash}`;
  }, { write: true });
  await step('provider close refused while plans are open (this run\'s plan)', () => refused(cli(['provider', 'close'], { allowFail: true }), ['open-plans-remain', 'open-leases-remain']));
  await step('plan create rejects a malformed amount / out-of-range terms', () => {
    refused(cli(['plan', 'create', '--duration', '3600', '--price', 'abc'], { allowFail: true }), ['invalid-field']);
    refused(cli(['plan', 'create', '--duration', '5'], { allowFail: true }), ['invalid-field']);
    refused(cli(['plan', 'create', '--duration', '3600', '--max', '0'], { allowFail: true }), ['invalid-field']);
  });
  await step('plan show reflects terms', () => { const r = cli(['plan', 'show', state.freePlan]); must(r.json.free && r.json.listed && r.json.dataCapGb === 1, 'terms'); });
  await step('plan list (fresh) contains it', () => { const r = cli(['plan', 'list', '--fresh']); must(r.json.plans.some((p) => p.address === state.freePlan), 'missing'); return `${r.json.plans.length} plans`; });
  await step('plan list --all (every provider) contains it', () => { const r = cli(['plan', 'list', '--all']); must(r.json.plans.some((p) => p.address === state.freePlan), 'missing'); return `${r.json.plans.length} plans on chain`; });
  await step('plan update duration 3600→7200, cap 1→2, max 1→2 — on chain', async () => {
    const r = cli(['plan', 'update', state.freePlan, '--duration', '7200', '--cap', '2', '--max', '2']); must(r.json.ok, 'update');
    const p = await onChain('plan', state.freePlan); eq(p.durationSeconds, 7200, 'duration'); eq(p.dataCapGb, 2, 'cap'); eq(p.maxConnections, 2, 'max'); eq(p.price, 0, 'price untouched');
    return r.json.txHash;
  }, { write: true });
  await step('plan update with nothing to change → 400', () => refused(cli(['plan', 'update', state.freePlan], { allowFail: true }), ['missing-field']));
  await step('subscriber cannot update, delist or close the operator\'s plan', async () => {
    refused(cli(['plan', 'update', state.freePlan, '--cap', '9'], { as: 'sub', allowFail: true }), ['provider-required', 'not-plan-owner']);
    refused(cli(['plan', 'status', state.freePlan, '--delisted'], { as: 'sub', allowFail: true }), ['provider-required', 'not-plan-owner']);
    refused(cli(['plan', 'close', state.freePlan], { as: 'sub', allowFail: true }), ['provider-required', 'not-plan-owner']);
    const p = await onChain('plan', state.freePlan); eq(p.dataCapGb, 2, 'cap unchanged'); eq(p.status, 1, 'still listed');
  });
  await step('plan delist → status 0 on chain', async () => { const r = cli(['plan', 'status', state.freePlan, '--delisted']); must(r.json.ok, 'delist'); eq((await onChain('plan', state.freePlan)).status, 0, 'status'); return r.json.txHash; }, { write: true });
  await step('subscriber subscribing to a delisted plan is refused', () => refused(cli(['subscriber', 'subscribe', state.freePlan], { as: 'sub', allowFail: true }), ['plan-not-listed']));
  await step('plan relist → status 1 on chain', async () => { const r = cli(['plan', 'status', state.freePlan]); must(r.json.ok, 'list'); eq((await onChain('plan', state.freePlan)).status, 1, 'status'); return r.json.txHash; }, { write: true });
  await step('plan create --no-list opens the plan unlisted (status 0), then close it', async () => {
    const r = cli(['plan', 'create', '--duration', '3600', '--no-list']); must(r.json.ok && r.json.planId, 'create'); state.unlistedPlan = r.json.planId;
    eq((await onChain('plan', state.unlistedPlan)).status, 0, 'status');
    await sleep(GAP_MS);
    const c = cli(['plan', 'close', state.unlistedPlan]); must(c.json.ok, 'close'); must(!(await onChain('plan', state.unlistedPlan)), 'plan still on chain'); state.unlistedPlan = null;
    return `create ${r.json.txHash} close ${c.json.txHash}`;
  }, { write: true });
  await step('plan status to the current value is a no-op (no tx)', () => { const r = cli(['plan', 'status', state.freePlan]); must(r.json.unchanged && !r.json.txHash, 'sent a tx'); });

  // ─── nodes + roster + lease (provider daemon) ──────────────────────────────
  say('— nodes, roster and lease (provider daemon)');
  await step('nodes list has the rig node, listed + live', () => { const r = cli(['nodes', 'list', '--search', NODE]); const x = r.json.nodes.find((y) => y.address === NODE); must(x && x.listed && x.live, 'rig node not listed+live'); return `${r.json.totalNodes} nodes on chain`; });
  await step('nodes list filters (country / protocol / paging)', () => {
    const all = cli(['nodes', 'list', '--limit', '100']).json; must(all.total >= 1, 'empty');
    const c = all.nodes[0].country; const byC = cli(['nodes', 'list', '--country', c]).json; must(byC.total >= 1 && byC.nodes.every((x) => x.country === c), 'country filter');
    const p = all.nodes[0].protocols[0]; if (p) { const byP = cli(['nodes', 'list', '--protocol', p]).json; must(byP.total >= 1 && byP.nodes.every((x) => x.protocols.includes(p)), 'protocol filter'); }
    const pg = cli(['nodes', 'list', '--limit', '1', '--page', '1']).json; must(pg.nodes.length === 1 && pg.pages === pg.total && pg.total >= 1, `paging: ${pg.nodes.length} rows, ${pg.pages} pages for ${pg.total} nodes`); // same response: the shared devnet gains nodes between calls
    return `${all.total} listed · ${Object.keys(all.countries).length} countries`;
  });
  await step('nodes list --all --refresh includes delisted nodes and rescans the chain', () => {
    const listed = cli(['nodes', 'list', '--limit', '1']).json; const every = cli(['nodes', 'list', '--all', '--refresh', '--limit', '1']).json;
    must(every.total >= listed.total, `--all returned ${every.total} < listed ${listed.total}`);
    return `${every.total} total vs ${listed.total} listed`;
  });
  await step('nodes count / rankings', () => { const c = cli(['nodes', 'count']); const k = cli(['nodes', 'rankings']); must(c.json.count >= 1 && Array.isArray(k.json.cheapestLease), 'count/rankings'); return `${c.json.listed} listed, cheapest lease ${k.json.cheapestLease[0]?.leasePerHourTdvpn} tDVPN/h`; });
  await step('nodes progress', () => { const r = cli(['nodes', 'progress']); must(typeof r.json.total === 'number', 'progress'); return `${r.json.total} cached`; });
  await step('lease end on an unknown lease → 404', () => refused(cli(['lease', 'end', rnd()], { allowFail: true }), ['lease-not-found']));
  await step('subscriber cannot link nodes to the operator\'s plan', () => refused(cli(['nodes', 'link', state.freePlan, NODE], { as: 'sub', allowFail: true }), ['provider-required', 'not-plan-owner']));
  await step('link node → roster', () => {
    daemonOnly();
    const r = cli(['nodes', 'link', state.freePlan, NODE]); must(r.json.ok && r.json.totalNodes === 1, 'roster'); state.linked.add(state.freePlan);
    return `live=${r.json.roster[0].live} lease=${r.json.roster[0].lease || 'pending'}`;
  });
  await step('members shows the roster node', () => { daemonOnly(); const r = cli(['plan', 'members', state.freePlan]); must(r.json.nodes.length === 1 && r.json.nodes[0].address === NODE, 'members'); });
  await step('nodes list --plan --exclude-in-plan hides it, --in-plan shows only it', () => {
    daemonOnly();
    must(cli(['nodes', 'list', '--plan', state.freePlan, '--exclude-in-plan', '--search', NODE]).json.total === 0, 'still visible');
    const inPlan = cli(['nodes', 'list', '--plan', state.freePlan, '--in-plan']).json; must(inPlan.total === 1 && inPlan.nodes[0].address === NODE, 'in-plan');
  });
  await step('lease keep → the keeper\'s lease for the node is OPEN on chain', async () => {
    daemonOnly(); must(cli(['lease', 'keep']).json.ok, 'lease keep');
    let l = null;
    for (let i = 0; i < 4 && !l; i++) { // on a fresh rig the keeper's open_lease may still be confirming
      if (i) await sleep(5000);
      l = cli(['lease', 'list']).json.leases.find((x) => x.node === NODE && x.status === 0);
    }
    must(l, 'no open lease for the rig node');
    const c = await onChain('lease', l.address); eq(c.provider, state.provider, 'lease provider'); eq(c.node, NODE, 'lease node'); eq(c.status, 0, 'lease status');
    state.lease = l.address; return `${l.address} escrow ${tdvpn(c.escrow)} tDVPN, ${l.modeName}`;
  });
  await step('lease end refused while the node is on a roster', async () => {
    daemonOnly(); refused(cli(['lease', 'end', state.lease], { allowFail: true }), ['lease-in-roster']);
    eq((await onChain('lease', state.lease)).status, 0, 'lease still open');
  });

  // ─── subscribers on the free plan ──────────────────────────────────────────
  say('— subscribers on the free plan');
  await step('gift a free subscription to the subscriber wallet — account on chain', async () => {
    const r = cli(['subscriber', 'add', state.freePlan, state.sub]); must(r.json.ok && r.json.added === 1, JSON.stringify(r.json));
    const addr = r.json.results[0].subscriptionId; trackSub(addr, 'op'); state.giftSub = addr;
    const s = await onChain('subscription', addr);
    eq(s.owner, state.sub, 'owner'); eq(s.plan, state.freePlan, 'plan'); eq(s.provider, state.provider, 'provider'); eq(s.price, 0, 'price');
    eq(Number(s.expiresAt) - Number(s.openedAt), 7200, 'duration'); eq(s.dataCapGb, 2, 'cap'); eq(s.maxConnections, 2, 'max'); eq(s.rentRecipient, state.op, 'rent recipient');
    return addr;
  }, { write: true });
  await step('gift again → already (no tx)', () => { const r = cli(['subscriber', 'add', state.freePlan, state.sub]); must(r.json.results[0].already && r.json.added === 0, 'not idempotent'); });
  await step('gift to a program-derived address → 400 not-a-wallet', () => refused(cli(['subscriber', 'add', state.freePlan, CONFIG_PDA], { allowFail: true }), ['not-a-wallet']));
  await step('add-many: 2 new + 2 rejected inputs, every rejection reported', async () => {
    const r = cli(['subscriber', 'add-many', state.freePlan, rnd(), rnd(), 'bogus', CONFIG_PDA]); must(r.json.added === 2, JSON.stringify(r.json));
    must(r.json.invalid?.length === 2, `invalid not reported: ${JSON.stringify(r.json.invalid)}`);
    const made = r.json.results.filter((x) => x.ok && !x.already).map((x) => x.subscriptionId);
    for (const a of made) { trackSub(a, 'op'); must(await onChain('subscription', a), `${a} not on chain`); }
    state.extraSubs = made; return `tx ${r.json.results[0].txHash}`;
  }, { write: true });
  await step('subscriptions list = chain', () => { const r = cli(['plan', 'subscriptions', state.freePlan]); must(r.json.total === 3, `total ${r.json.total}`); return `${r.json.total} subscriptions`; });
  await step('subscriber sees its gifted subscription as active', () => { const r = cli(['subscriber', 'own', state.freePlan], { as: 'sub' }); must(r.json.subscribed && r.json.subscription.active, 'not active'); eq(r.json.subscription.subscriptionId, state.giftSub, 'subscription'); });
  await step('subscriber requests an access ticket for the gift (provider verifies chain)', () => {
    daemonOnly();
    const r = cli(['subscriber', 'ticket', state.freePlan, '--node', NODE], { as: 'sub', allowFail: true }); must(r.ok, `ticket refused: ${JSON.stringify(r.json).slice(0, 200)}`);
    const t = r.json.ticket;
    must(r.json.tlsPinned === true, 'ticket request was not TLS-pinned to the provider'); must(t.signatureValid, 'ticket signature invalid'); eq(t.user, state.sub, 'ticket user'); eq(t.subscription, state.giftSub, 'ticket subscription');
    eq(t.node, NODE, 'ticket node'); eq(t.provider, state.provider, 'ticket provider'); // The daemon caps each ticket's bytes from its own [tickets] config, so only the bound is asserted; connections pass through.
    must(BigInt(t.dataCapBytes) > 0n && BigInt(t.dataCapBytes) <= 2n * 10n ** 9n, `ticket cap ${t.dataCapBytes} B outside (0, subscription's 2 GB]`);
    eq(t.maxConnections, 2, 'ticket max connections');
    must(t.expiresAt > Math.floor(Date.now() / 1000), 'ticket already expired');
    return `cap ${t.dataCapBytes} B, ${t.maxConnections} conn, expires ${new Date(t.expiresAt * 1000).toISOString()} in ${r.json.latencyMs} ms`;
  });
  await step('ticket for a node NOT on the plan\'s roster is refused by the provider', () => {
    daemonOnly();
    const other = cli(['nodes', 'list', '--limit', '100']).json.nodes.find((x) => x.address !== NODE && x.live);
    if (!other) throw skip('no second live node on chain');
    const r = cli(['subscriber', 'ticket', state.freePlan, '--node', other.address], { as: 'sub', allowFail: true }); refused(r, ['ticket-refused']);
    return (r.json?.error || '').slice(0, 90);
  });
  await step('operator self-subscribes (free) — account on chain', async () => {
    const r = cli(['subscriber', 'subscribe', state.freePlan]); must(r.json.ok, JSON.stringify(r.json));
    state.ownSub = r.json.subscriptionId; trackSub(state.ownSub, 'op');
    const s = await onChain('subscription', state.ownSub); eq(s.owner, state.op, 'owner'); eq(s.rentRecipient, state.op, 'rent recipient'); return state.ownSub;
  }, { write: true });
  await step('own-subscription active', () => { const r = cli(['subscriber', 'own', state.freePlan]); must(r.json.subscribed && r.json.subscription.active, 'not active'); });
  await step('subscribe twice → already-subscribed', () => refused(cli(['subscriber', 'subscribe', state.freePlan], { allowFail: true }), ['already-subscribed']));
  await step('operator ticket on its own subscription', () => {
    daemonOnly(); const r = cli(['subscriber', 'ticket', state.freePlan, '--node', NODE], { allowFail: true }); must(r.ok, `ticket refused: ${JSON.stringify(r.json).slice(0, 200)}`);
    must(r.json.ticket.signatureValid, 'signature'); eq(r.json.ticket.user, state.op, 'user'); eq(r.json.ticket.subscription, state.ownSub, 'subscription');
  });
  await step('share payload names the plan, provider, mint and vault', () => {
    const r = cli(['plan', 'share', state.freePlan, '--for', state.sub]); const c = r.json.share.command;
    for (const x of [state.freePlan, state.provider, MINT.toBase58(), state.vault, state.sub]) must(c.includes(x), `share command missing ${x}`);
  });
  await step('subscriber cannot close someone else\'s unexpired subscription', async () => {
    refused(cli(['subscriber', 'close', state.ownSub], { as: 'sub', allowFail: true }), ['not-subscription-owner']);
    must(await onChain('subscription', state.ownSub), 'subscription vanished');
  });
  await step('close own subscription — account gone, rent back to the operator', async () => {
    const rent = await lamports(state.ownSub);
    const r = cli(['subscriber', 'close', state.ownSub]); must(r.json.ok, 'close');
    must(!(await onChain('subscription', state.ownSub)), 'still on chain'); untrackSub(state.ownSub); state.ownSub = null;
    eq(await txLamportDelta(r.json.txHash, state.op), rent - await txFee(r.json.txHash), 'rent refund minus the fee, in the tx');
    return `rent ${rent} lamports refunded · ${r.json.txHash}`;
  }, { write: true });
  await step('subscriber closes its own gifted subscription — rent goes to the payer (operator)', async () => {
    const rent = await lamports(state.giftSub);
    const r = cli(['subscriber', 'close', state.giftSub], { as: 'sub' }); must(r.json.ok, 'close');
    must(!(await onChain('subscription', state.giftSub)), 'still on chain'); untrackSub(state.giftSub); eq(await txLamportDelta(r.json.txHash, state.op), rent, 'operator rent refund in the tx');
    untrackSub(state.giftSub); state.giftSub = null; return r.json.txHash;
  }, { write: true });
  for (const sub of state.extraSubs || []) {
    await step(`provider closes free gift ${sub.slice(0, 8)}… — account gone`, async () => {
      const r = cli(['subscriber', 'close', sub]); must(r.json.ok, 'close'); must(!(await onChain('subscription', sub)), 'still on chain'); untrackSub(sub); return r.json.txHash;
    }, { write: true });
  }

  // ─── priced plan: a third party buys, uses, expires ────────────────────────
  say(`— priced plan: subscriber buys, plan expires after ${PRICED_DURATION} s`);
  await step(`create priced plan ${PRICE} tDVPN / ${PRICED_DURATION} s — terms on chain`, async () => {
    const r = cli(['plan', 'create', '--price', PRICE, '--duration', String(PRICED_DURATION), '--cap', '1', '--max', '2']); must(r.json.ok, 'create'); state.pricedPlan = r.json.planId;
    const p = await onChain('plan', state.pricedPlan); eq(p.price, 1000, 'price'); eq(p.durationSeconds, PRICED_DURATION, 'duration'); eq(p.status, 1, 'status');
    return state.pricedPlan;
  }, { write: true });
  await step('gifting on a priced plan is refused with a share payload', () => {
    const r = cli(['subscriber', 'add', state.pricedPlan, state.sub], { allowFail: true }); refused(r, ['subscriber-must-self-subscribe']); must(r.json.share?.command?.includes(state.sub), 'share payload');
  });
  await step('link the node to the priced plan too (one lease serves both)', () => {
    daemonOnly(); const r = cli(['nodes', 'link', state.pricedPlan, NODE]); must(r.json.ok && r.json.totalNodes === 1, 'roster'); state.linked.add(state.pricedPlan);
  });
  await step(`subscriber buys it: exact tDVPN moves (−price, vault +price, revenue +${100 - 2}%, fees +2%)`, async () => {
    const [subT, prov] = [await tokenBase(state.sub), await onChain('provider', state.provider)];
    const r = cli(['subscriber', 'subscribe', state.pricedPlan], { as: 'sub' }); must(r.json.ok, JSON.stringify(r.json));
    state.pricedSub = r.json.subscriptionId; trackSub(state.pricedSub, 'sub');
    const fee = (1000n * BigInt(state.feeBps)) / 10_000n;
    const prov2 = await onChain('provider', state.provider);
    eq(subT - await tokenBase(state.sub), 1000n, 'subscriber paid');
    eq(await txTokenDelta(r.json.txHash, { account: state.vault }), 1000n, 'vault received (in the tx)');
    eq(BigInt(prov2.revenue) - BigInt(prov.revenue), 1000n - fee, 'provider revenue');
    eq(BigInt(prov2.feesAccrued) - BigInt(prov.feesAccrued), fee, 'protocol fees');
    const s = await onChain('subscription', state.pricedSub); eq(s.owner, state.sub, 'owner'); eq(s.price, 1000, 'price'); eq(s.rentRecipient, state.sub, 'rent recipient');
    // Baseline for the lease-funding row: revenue now, and the slot after which top-ups count.
    state.revenueAfterBuy = BigInt(prov2.revenue); state.buySlot = (await txMeta(r.json.txHash)).slot;
    return `revenue +${tdvpn(1000n - fee)} · fees +${tdvpn(fee)} · ${r.json.txHash}`;
  }, { write: true });
  await step('subscriber gets a ticket on the paid plan', () => {
    daemonOnly(); const r = cli(['subscriber', 'ticket', state.pricedPlan, '--node', NODE], { as: 'sub', allowFail: true }); must(r.ok, `ticket refused: ${JSON.stringify(r.json).slice(0, 200)}`);
    must(r.json.tlsPinned === true, 'paid-plan ticket request was not TLS-pinned'); eq(r.json.ticket.user, state.sub, 'user'); must(BigInt(r.json.ticket.dataCapBytes) > 0n && BigInt(r.json.ticket.dataCapBytes) <= 10n ** 9n, 'ticket cap exceeds the 1 GB subscription'); must(r.json.ticket.signatureValid, 'signature');
  });
  await step('provider cannot close a PAID unexpired subscription', async () => {
    refused(cli(['subscriber', 'close', state.pricedSub], { allowFail: true }), ['not-subscription-owner']); must(await onChain('subscription', state.pricedSub), 'vanished');
  });
  await step('wait for the paid subscription to expire', async () => {
    const s = await onChain('subscription', state.pricedSub); const wait = Number(s.expiresAt) - Math.floor(Date.now() / 1000) + 3;
    if (wait > 0) await sleep(wait * 1000);
    const r = cli(['subscriber', 'own', state.pricedPlan], { as: 'sub' }); must(r.json.subscribed && !r.json.subscription.active, 'still active');
    return `waited ${Math.max(0, wait)} s`;
  });
  await step('ticket on an expired subscription → 409', () => refused(cli(['subscriber', 'ticket', state.pricedPlan, '--node', NODE], { as: 'sub', allowFail: true }), ['subscription-expired']));
  await step('anyone may close an expired subscription — provider closes it, rent goes back to the subscriber', async () => {
    const before = await lamports(state.sub); const rent = await lamports(state.pricedSub);
    const r = cli(['subscriber', 'close', state.pricedSub]); must(r.json.ok, JSON.stringify(r.json));
    must(!(await onChain('subscription', state.pricedSub)), 'still on chain'); untrackSub(state.pricedSub); eq((await lamports(state.sub)) - before, rent, 'subscriber rent refund'); eq(await txLamportDelta(r.json.txHash, state.sub), rent, 'refund in the tx');
    untrackSub(state.pricedSub); state.pricedSub = null; return `${rent} lamports back to the subscriber · ${r.json.txHash}`;
  }, { write: true });

  // ─── unlink + close plans ──────────────────────────────────────────────────
  say('— unlink and close plans');
  for (const key of ['freePlan', 'pricedPlan']) {
    await step(`unlink node from the ${key === 'freePlan' ? 'free' : 'priced'} plan → roster empty`, () => {
      if (!state.linked.has(state[key])) throw skip('not linked');
      const r = cli(['nodes', 'unlink', state[key], NODE]); must(r.json.ok && r.json.totalNodes === 0, 'roster'); state.linked.delete(state[key]);
    });
    await step(`close the ${key === 'freePlan' ? 'free' : 'priced'} plan (delist+close) — account gone`, async () => {
      const r = cli(['plan', 'close', state[key]]); must(r.json.ok, 'close'); must(!(await onChain('plan', state[key])), 'plan still on chain'); state[key] = null; return r.json.txHash;
    }, { write: true });
  }
  await step('keeper after unlink: keeps the lease while other plans still route the node, winds it down otherwise', async () => {
    daemonOnly(); if (!state.lease) throw skip('no lease recorded');
    // Plans this run did not create may still have the node on their roster.
    const stillUsing = cli(['plan', 'list', '--fresh']).json.plans
      .filter((p) => cli(['plan', 'members', p.address]).json.nodes.some((x) => x.address === NODE)).map((p) => p.address);
    let c = null;
    for (let i = 0; i < 4; i++) {
      must(cli(['lease', 'keep']).json.ok, 'lease keep'); c = await onChain('lease', state.lease);
      if (stillUsing.length || !c || c.status !== 0) break;
      await sleep(5000);
    }
    if (stillUsing.length) {
      must(c && c.status === 0, 'keeper closed a lease that other plans still route');
      return `lease stays open: node still on ${stillUsing.length} other plan roster(s) (${stillUsing.map((p) => p.slice(0, 8)).join(', ')})`;
    }
    must(!c || c.status !== 0, 'lease still open after unlinking from every plan');
    return c ? `closing since ${new Date(Number(c.closeStartedAt) * 1000).toISOString()}` : 'closed';
  });

  // ─── earnings ──────────────────────────────────────────────────────────────
  say('— earnings');
  await step('earnings = chain provider account', async () => {
    const e = cli(['earnings', 'show', '--fresh']).json; const p = await onChain('provider', state.provider);
    eq(e.provider.revenue, p.revenue, 'revenue'); eq(e.provider.feesAccrued, p.feesAccrued, 'fees'); eq(e.provider.bond, p.bond, 'bond');
    return `revenue ${e.provider.revenueTdvpn} · fees ${e.provider.feesAccruedTdvpn} · bond ${e.provider.bondTdvpn}`;
  });
  await step('withdraw more revenue than available → 400', () => refused(cli(['earnings', 'withdraw-revenue', '--amount', '999999'], { allowFail: true }), ['insufficient-revenue']));
  await step('keeper top-ups draw balance → revenue → wallet (LeaseFunded, exact) and account for every unit of revenue', async () => {
    must(state.revenueAfterBuy !== undefined && state.lease, 'no purchase baseline or lease recorded');
    const events = await leaseFundedSince(state.lease, state.buySlot);
    let spent = 0n;
    for (const e of events) {
      const fromWallet = e.amount - e.fromBalance - e.fromRevenue;
      must(fromWallet >= 0n, `top-up ${e.sig}: parts exceed the amount`);
      eq(-e.ownerDelta(state.op), fromWallet, `top-up ${e.sig.slice(0, 8)}: owner wallet paid the remainder (in the tx)`);
      if (e.fromRevenue > 0n) eq(e.providerBalance, 0n, `top-up ${e.sig.slice(0, 8)}: revenue used before the balance was empty`);
      if (fromWallet > 0n) eq(e.providerRevenue, 0n, `top-up ${e.sig.slice(0, 8)}: wallet used before the revenue was empty`);
      spent += e.fromRevenue;
    }
    // This provider's only paid plan closed after the purchase, so revenue changed by top-ups alone.
    eq(BigInt((await onChain('provider', state.provider)).revenue), state.revenueAfterBuy - spent, 'revenue = after purchase − drawn by top-ups');
    return events.length
      ? `${events.length} top-up(s): ${tdvpn(spent)} tDVPN from revenue, rest from balance/wallet · ${events.map((e) => e.sig.slice(0, 8)).join(', ')}`
      : 'no top-up since the purchase: revenue untouched';
  });
  await step('withdraw what the keeper left: part (0.0001) then the rest, exact; or nothing-to-withdraw if it spent it all', async () => {
    const p = await onChain('provider', state.provider); let left = BigInt(p.revenue); const sigs = [];
    if (left === 0n) { refused(cli(['earnings', 'withdraw-revenue'], { allowFail: true }), ['nothing-to-withdraw']); return 'revenue 0 (spent on lease top-ups) → 409'; }
    if (left >= 100n) {
      const r = cli(['earnings', 'withdraw-revenue', '--amount', '0.0001']); must(r.json.ok, 'withdraw part');
      eq(await txTokenDelta(r.json.txHash, { owner: state.op }), 100n, 'owner received the part (in the tx)'); left -= 100n; sigs.push(r.json.txHash);
    }
    const r = cli(['earnings', 'withdraw-revenue']); must(r.json.ok, 'withdraw rest');
    eq(await txTokenDelta(r.json.txHash, { owner: state.op }), left, 'owner received the rest (in the tx)'); sigs.push(r.json.txHash);
    eq((await onChain('provider', state.provider)).revenue, 0, 'revenue');
    return `${tdvpn(p.revenue)} tDVPN withdrawn · ${sigs.join(', ')}`;
  }, { write: true });
  await step('sweep protocol fees — treasury receives exactly the accrued fees', async () => {
    const p = await onChain('provider', state.provider); if (BigInt(p.feesAccrued) === 0n) throw skip('no fees accrued');
    must((await tokenAccountBase(state.treasury)) !== null, `treasury ${state.treasury} is not a token account`);
    const r = cli(['earnings', 'sweep-fees']); must(r.json.ok, 'sweep');
    eq(await txTokenDelta(r.json.txHash, { account: state.treasury }), BigInt(p.feesAccrued), 'treasury received (in the tx)'); eq((await onChain('provider', state.provider)).feesAccrued, 0, 'fees');
    return `${tdvpn(p.feesAccrued)} tDVPN · ${r.json.txHash}`;
  }, { write: true });
  await step('sweep with nothing accrued → 409', () => refused(cli(['earnings', 'sweep-fees'], { allowFail: true }), ['nothing-to-sweep']));
  await step('withdraw-revenue with nothing left → 409', () => refused(cli(['earnings', 'withdraw-revenue'], { allowFail: true }), ['nothing-to-withdraw']));
  // Lease closes refund unspent escrow into the provider balance, so a lease of an earlier
  // run that finalised during this one leaves money here: withdraw it exactly, else expect 409.
  await step('withdraw-balance: exactly what lease refunds left, or 409 on an empty balance', async () => {
    const before = BigInt((await onChain('provider', state.provider)).balance);
    if (before === 0n) { refused(cli(['earnings', 'withdraw-balance'], { allowFail: true }), ['nothing-to-withdraw']); return 'balance 0 → 409'; }
    const r = cli(['earnings', 'withdraw-balance']); must(r.json.ok, 'withdraw-balance');
    eq(BigInt(r.json.amount), before, 'amount withdrawn');
    eq(await txTokenDelta(r.json.txHash, { owner: state.op }), before, 'operator received (in the tx)');
    eq(BigInt((await onChain('provider', state.provider)).balance), 0n, 'provider balance after');
    refused(cli(['earnings', 'withdraw-balance'], { allowFail: true }), ['nothing-to-withdraw']);
    return `${tdvpn(before)} tDVPN (lease refunds) withdrawn, then 409 · ${r.json.txHash}`;
  }, { write: true });
  await step('withdraw-user-balance on an empty balance → 409 (operator and subscriber)', () => {
    refused(cli(['earnings', 'withdraw-user-balance'], { allowFail: true }), ['nothing-to-withdraw']);
    refused(cli(['earnings', 'withdraw-user-balance'], { as: 'sub', allowFail: true }), ['nothing-to-withdraw']);
  });
  await step('subscriber has no provider earnings', () => { const e = cli(['earnings', 'show'], { as: 'sub' }).json; must(e.provider === null, 'subscriber shows provider earnings'); });
  await step('fee grants report work-in-progress', () => { const r = cli(['feegrant', 'status']); must(r.json.wip === true, 'not wip'); });

  // ─── drain the subscriber back to the operator ─────────────────────────────
  say('— drain the subscriber wallet back to the operator');
  await step('subscriber sends all its tDVPN back through the console', async () => {
    const bal = (await tokenBase(state.sub)) ?? 0n; if (bal === 0n) throw skip('nothing to return');
    const r = cli(['wallet', 'send', '--to', state.op, '--amount', tdvpn(bal), '--asset', 'TDVPN'], { as: 'sub' }); must(r.json.ok, 'send');
    eq(await tokenBase(state.sub), 0n, 'subscriber tDVPN'); eq(await txTokenDelta(r.json.txHash, { owner: state.op }), bal, 'operator received (in the tx)');
    return `${tdvpn(bal)} tDVPN · ${r.json.txHash}`;
  }, { write: true });
  await step('subscriber logs out', () => { cli(['wallet', 'logout'], { as: 'sub' }); must(cli(['wallet', 'status'], { as: 'sub' }).json.loaded === false, 'still loaded'); });
  await step('operator logs out', () => { cli(['wallet', 'logout']); must(cli(['wallet', 'status']).json.loaded === false, 'still loaded'); });
} finally {
  say('— cleanup');
  let leftovers = 0;
  const opIn = () => cli(['wallet', 'import', '--file', process.env.TEST_KEYFILE], { allowFail: true });
  const subIn = () => cli(['wallet', 'import', '--file', SUB_KEYFILE], { as: 'sub', allowFail: true });
  if (state.subs.size || state.linked.size || state.freePlan || state.pricedPlan || state.unlistedPlan || state.uriDirty || state.delisted) { opIn(); subIn(); }
  // Provider state the run changed on chain is put back first (a crash mid-run must not leave it).
  if (state.uriDirty) { leftovers++; const r = cli(['provider', 'register', '--uri', state.providerUri], { allowFail: true }); say(`  restore provider uri: ${r.ok ? 'ok' : JSON.stringify(r.json).slice(0, 160)}`); await sleep(GAP_MS); }
  if (state.delisted) { leftovers++; const r = cli(['provider', 'status'], { allowFail: true }); say(`  relist provider: ${r.ok ? 'ok' : JSON.stringify(r.json).slice(0, 160)}`); await sleep(GAP_MS); }
  for (const [sub, closer] of state.subs) {
    leftovers++;
    let r = cli(['subscriber', 'close', sub], { as: closer, allowFail: true });
    if (!r.ok) r = cli(['subscriber', 'close', sub], { as: closer === 'op' ? 'sub' : 'op', allowFail: true });
    say(`  close sub ${sub}: ${r.ok ? 'ok' : JSON.stringify(r.json).slice(0, 160)}`); await sleep(GAP_MS);
  }
  for (const plan of state.linked) { leftovers++; const r = cli(['nodes', 'unlink', plan, NODE], { allowFail: true }); say(`  unlink ${plan}: ${r.ok ? 'ok' : JSON.stringify(r.json).slice(0, 160)}`); }
  for (const plan of [state.freePlan, state.pricedPlan, state.unlistedPlan].filter(Boolean)) { leftovers++; const r = cli(['plan', 'close', plan], { allowFail: true }); say(`  close plan ${plan}: ${r.ok ? 'ok' : JSON.stringify(r.json).slice(0, 160)}`); await sleep(GAP_MS); }
  // Drain whatever the subscriber still holds straight back to the operator,
  // close its token account (rent back too), and delete its key only once empty.
  try {
    const op = state.op || Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.TEST_KEYFILE, 'utf8')))).publicKey.toBase58();
    const subAta = getAssociatedTokenAddressSync(MINT, subKp.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const tok = await tokenBase(state.sub);
    if (tok !== null && tok > 0n) { leftovers++; subIn(); const r = cli(['wallet', 'send', '--to', op, '--amount', tdvpn(tok), '--asset', 'TDVPN'], { as: 'sub', allowFail: true }); say(`  return ${tdvpn(tok)} tDVPN: ${r.ok ? 'ok' : JSON.stringify(r.json).slice(0, 160)}`); await sleep(GAP_MS); }
    const tx = new Transaction();
    if ((await tokenBase(state.sub)) === 0n) tx.add(createCloseAccountInstruction(subAta, new PublicKey(op), subKp.publicKey, [], TOKEN_2022_PROGRAM_ID));
    const sol = await lamports(state.sub);
    if (sol > 5000) tx.add(SystemProgram.transfer({ fromPubkey: subKp.publicKey, toPubkey: new PublicKey(op), lamports: sol - 5000 }));
    if (tx.instructions.length) {
      // Confirm over HTTP: sendAndConfirmTransaction waits on a websocket web3 guesses at
      // port+1, which the rpc-gate does not serve, so it reported a landed sweep as expired.
      const c = sendConnection();
      const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash; tx.feePayer = subKp.publicKey; tx.sign(subKp);
      const sig = await c.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
      for (;;) {
        const st = (await c.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
        if (st?.err) throw new Error(`sweep ${sig} failed on chain: ${JSON.stringify(st.err)}`);
        if (st && ['confirmed', 'finalized'].includes(st.confirmationStatus)) break;
        if ((await c.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error(`sweep ${sig} expired unconfirmed`);
        await sleep(2000);
      }
      say(`  subscriber drained: ${tx.instructions.length > 1 ? 'token account closed, ' : ''}${(sol - 5000) / 1e9} SOL back · ${sig}`);
    }
    const left = await lamports(state.sub); const ataLeft = await conn.getAccountInfo(subAta);
    if (left === 0 && !ataLeft) { unlinkSync(SUB_KEYFILE); say('  subscriber wallet empty, key file deleted'); }
    else say(`  subscriber still holds ${left} lamports${ataLeft ? ' and a token account' : ''}; key kept at ${SUB_KEYFILE} for the next run`);
  } catch (e) {
    say(`  subscriber drain failed (key kept at ${SUB_KEYFILE}): ${e.message}`);
  }
  // Neither jar keeps a live session cookie after the run.
  cli(['wallet', 'logout'], { allowFail: true });
  if (existsSync(SESSIONS.sub)) { cli(['wallet', 'logout'], { as: 'sub', allowFail: true }); unlinkSync(SESSIONS.sub); }
  if (!leftovers) say('  nothing of ours was left open');
  const passed = results.filter((r) => r.ok && !r.skip).length; const skipped = results.filter((r) => r.skip).length; const failed = results.filter((r) => !r.ok).length;
  say(`\ncli-e2e: ${passed} passed, ${skipped} skipped, ${failed} failed`);
  const rc = getRpcCounters();
  say(`rpc (suite): ${rc.requests} requests, ${rc.rateLimited} × 429, ${rc.transportErrors} transport errors in ${rc.seconds} s`);
  try {
    const srv = (await (await fetch(`${BASE}/health/rpc`)).json()).counters;
    say(`rpc (server): ${srv.requests} requests, ${srv.rateLimited} × 429, ${srv.transportErrors} transport errors since server start`);
  } catch (e) {
    say(`  server rpc counters unavailable: ${e.message}`);
  }
  mkdirSync(dirname(LOG), { recursive: true });
  writeFileSync(LOG, lines.join('\n') + '\n', 'utf8');
  process.exit(failed ? 1 : (skipped && process.env.E2E_ALLOW_SKIP !== '1' ? 2 : 0));
}
