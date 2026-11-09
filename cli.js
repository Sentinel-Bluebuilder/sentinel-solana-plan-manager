#!/usr/bin/env node
// ─── Plan Manager (Solana) CLI ───────────────────────────────────────────────
// Thin HTTP client for the Plan Manager server. Every API route maps to a
// subcommand, so the whole console can be driven — and end-to-end tested —
// from a terminal or a script. Node built-ins only.
//
//   plans <group> <cmd> [args] [--flags]
//   --json            raw JSON output (what scripts/cli-e2e.mjs consumes)
//   --base-url URL    server (default http://127.0.0.1:$PORT, PORT from .env or 3003)
//   --session FILE    cookie jar (default .cli-session.json next to this file)
//   -h / --help
//
// Sessions: `plans wallet import --file <keyfile>` stores the server's cookie
// in the jar; every later command sends it. Wallet-extension sessions cannot
// be driven from a terminal (they sign in the browser) — the CLI is the
// keypair path, which is also what the e2e suite exercises.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ─── args ────────────────────────────────────────────────────────────────────
// Boolean flags never consume the next token, so `lease end --force <pda>` keeps its positional.
const BOOL_FLAGS = new Set(['json', 'help', 'all', 'fresh', 'delisted', 'no-list', 'refresh', 'exclude-in-plan', 'in-plan', 'force']);
function parseArgs(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; } // --key=value also passes values that start with --
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOL_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const JSON_MODE = !!flags.json;

function envPort() {
  try {
    const env = readFileSync(join(here, '.env'), 'utf8');
    const m = env.match(/^PORT=(\d+)/m);
    return m ? m[1] : '3003';
  } catch (err) { return '3003'; }
}
const BASE_URL = String(flags['base-url'] || process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || envPort()}`).replace(/\/$/, '');
const SESSION_FILE = String(flags.session || process.env.PLANS_SESSION_FILE || join(here, '.cli-session.json'));

// ─── output ──────────────────────────────────────────────────────────────────
const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');
function printJson(d) { out(JSON.stringify(d, null, 2)); }
function printKv(obj, indent = '') {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) out(`${indent}${k}: --`);
    else if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) out(`${indent}${k}: ${JSON.stringify(v)}`);
    else if (Array.isArray(v)) { out(`${indent}${k}: [${v.length}]`); v.slice(0, 50).forEach((x, i) => { out(`${indent}  - #${i}`); printKv(x, indent + '    '); }); if (v.length > 50) out(`${indent}  … and ${v.length - 50} more (use --json for all)`); }
    else if (typeof v === 'object') { out(`${indent}${k}:`); printKv(v, indent + '  '); }
    else out(`${indent}${k}: ${v}`);
  }
}
function show(d) { if (JSON_MODE) printJson(d); else if (d && typeof d === 'object') printKv(d); else out(String(d)); }
function fail(msg, code = 1) { if (JSON_MODE) printJson({ ok: false, error: msg }); else err(`error: ${msg}`); process.exit(code); }

// ─── http with a cookie jar ──────────────────────────────────────────────────
function loadJar() { try { return existsSync(SESSION_FILE) ? JSON.parse(readFileSync(SESSION_FILE, 'utf8')) : {}; } catch (e) { return {}; } }
// The jar holds the server's encrypted-key cookie: owner-only mode, written only when a cookie changed.
function saveJar(jar) { writeFileSync(SESSION_FILE, JSON.stringify(jar), { encoding: 'utf8', mode: 0o600 }); }
function captureCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  let changed = false;
  for (const sc of list) {
    const [pair, ...attrs] = sc.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim(); const value = pair.slice(eq + 1).trim();
    const maxAge = attrs.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith('max-age='));
    if (maxAge && Number(maxAge.split('=')[1]) === 0) { if (name in jar) changed = true; delete jar[name]; } else if (jar[name] !== value) { jar[name] = value; changed = true; }
  }
  return changed;
}
async function api(method, path, body) {
  const jar = loadJar();
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    fail(`cannot reach ${BASE_URL}: ${e.message} (is the server running? node server.js)`, 2);
  }
  if (captureCookies(res, jar)) saveJar(jar);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 300) }; }
  if (!res.ok && !(data && data.mode === 'wallet-sign')) {
    const d = { status: res.status, ...(typeof data === 'object' ? data : { raw: data }) };
    if (JSON_MODE) { printJson(d); process.exit(1); }
    err(`HTTP ${res.status}: ${d.error || d.raw || 'request failed'}${d.errorCode ? ` [${d.errorCode}]` : ''}`);
    if (d.share) { err('share:'); err(d.share.command); }
    process.exit(1);
  }
  return data;
}
const get = (p) => api('GET', p);
const post = (p, b = {}) => api('POST', p, b);
const q = (obj) => { const s = new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== false && v !== '')); return s.toString() ? `?${s}` : ''; };
const need = (v, label) => { if (v === undefined || v === '') fail(`${label} required`); return v; };
const listArg = (arr, label) => { if (!arr.length) fail(`${label} required`); return arr; };

// ─── commands ────────────────────────────────────────────────────────────────
const commands = {
  wallet: {
    status: () => get('/api/wallet/status'),
    generate: () => post('/api/wallet/generate'),
    import: async () => {
      let key = flags.key;
      if (flags.file) key = readFileSync(String(flags.file), 'utf8');
      if (!key && process.env.TEST_KEYFILE) key = readFileSync(process.env.TEST_KEYFILE, 'utf8');
      if (!key && !process.stdin.isTTY) key = readFileSync(0, 'utf8');
      if (!key) fail('give --file <solana-keygen json> or --key <array|base58|phrase>');
      return post('/api/wallet/import', { key: String(key).trim() });
    },
    logout: () => post('/api/wallet/logout'),
    balance: () => get('/api/wallet'),
    show: () => get('/api/wallet'),
    qr: () => get('/api/wallet/qr'),
    'privy-config': () => get('/api/wallet/privy-config'),
    send: () => post('/api/wallet/send', { to: need(flags.to, '--to'), amount: need(flags.amount, '--amount'), asset: flags.asset || 'TDVPN' }),
  },
  provider: {
    list: () => get(`/api/providers${q({ all: flags.all ? 1 : undefined, fresh: flags.fresh ? 1 : undefined })}`),
    daemon: () => get('/api/providers/daemon'),
    select: () => post('/api/provider/select', { provider: need(positional[2], 'provider pda') }),
    register: () => post('/api/provider/register', { uri: need(flags.uri, '--uri') }),
    status: () => post('/api/provider/status', { status: flags.delisted ? 0 : 1 }),
    close: () => post('/api/provider/close'),
    unbonding: () => get('/api/provider/unbonding'),
    'withdraw-bond': () => post('/api/provider/withdraw-bond'),
  },
  plan: {
    list: () => (flags.all ? get('/api/plans') : get(`/api/my-plans${q({ fresh: flags.fresh ? 1 : undefined })}`)),
    show: () => get(`/api/plans/${need(positional[2], 'plan pda')}`),
    create: () => post('/api/plan/create', {
      priceTdvpn: flags.price ?? '0', durationSeconds: need(flags.duration, '--duration <seconds>'), dataCapGb: flags.cap ?? 0, maxConnections: flags.max ?? 1, list: !flags['no-list'],
    }),
    update: () => post('/api/plan/update', { planId: need(positional[2], 'plan pda'), priceTdvpn: flags.price, durationSeconds: flags.duration, dataCapGb: flags.cap, maxConnections: flags.max }),
    status: () => post('/api/plan/status', { planId: need(positional[2], 'plan pda'), status: flags.delisted ? 0 : 1 }),
    close: () => post('/api/plan/close', { planId: need(positional[2], 'plan pda') }),
    members: () => get(`/api/plans/${need(positional[2], 'plan pda')}/members`),
    subscriptions: () => get(`/api/plans/${need(positional[2], 'plan pda')}/subscriptions`),
    share: () => get(`/api/plans/${need(positional[2], 'plan pda')}/share${q({ for: flags.for })}`),
  },
  subscriber: {
    subscribe: () => post('/api/plan/subscribe', { planId: need(positional[2], 'plan pda') }),
    own: () => get(`/api/plans/${need(positional[2], 'plan pda')}/own-subscription`),
    add: () => post('/api/plan/add-subscriber', { planId: need(positional[2], 'plan pda'), address: need(positional[3], 'address') }),
    'add-many': () => post('/api/plan/add-subscribers', { planId: need(positional[2], 'plan pda'), addresses: listArg(positional.slice(3), 'addresses') }),
    close: () => post('/api/plan/close-subscription', { subscription: need(positional[2], 'subscription pda') }),
    ticket: () => post('/api/plan/request-ticket', { planId: need(positional[2], 'plan pda'), node: need(flags.node, '--node <node pda>') }),
  },
  nodes: {
    list: () => get(`/api/all-nodes${q({ page: flags.page, limit: flags.limit, search: flags.search, country: flags.country, protocol: flags.protocol, planId: flags.plan, excludeInPlan: flags['exclude-in-plan'] ? 'true' : undefined, inPlanOnly: flags['in-plan'] ? 'true' : undefined, listedOnly: flags.all ? 'false' : undefined, refresh: flags.refresh ? 1 : undefined })}`),
    count: () => get('/api/nodes/chain-count'),
    progress: () => get('/api/nodes/progress'),
    rankings: () => get('/api/node-rankings'),
    link: () => post('/api/plan-manager/batch-link', { planId: need(positional[2], 'plan pda'), nodeAddresses: listArg(positional.slice(3), 'node pda(s)') }),
    unlink: () => post('/api/plan-manager/batch-unlink', { planId: need(positional[2], 'plan pda'), nodeAddresses: listArg(positional.slice(3), 'node pda(s)') }),
  },
  lease: {
    list: () => get('/api/leases'),
    keep: () => post('/api/lease/keep'),
    end: () => post('/api/lease/end', { lease: need(positional[2], 'lease pda'), force: flags.force === true || undefined }),
  },
  earnings: {
    show: () => get(`/api/earnings${q({ fresh: flags.fresh ? 1 : undefined })}`),
    'withdraw-revenue': () => post('/api/earnings/withdraw-revenue', { amount: flags.amount ?? 'all' }),
    'withdraw-balance': () => post('/api/earnings/withdraw-balance'),
    'sweep-fees': () => post('/api/earnings/sweep-fees'),
    'withdraw-user-balance': () => post('/api/earnings/withdraw-user-balance'),
  },
  feegrant: {
    status: () => get('/api/feegrant/grants'),
  },
  params: {
    show: () => get('/api/params'),
    price: () => get('/api/price'),
  },
  rpc: { show: () => get('/health/rpc') },
  health: {
    show: () => get('/health'),
    daemons: () => get('/health/daemons'),
  },
};

const HELP = `plans — Sentinel Plan Manager (Solana) CLI       server: ${BASE_URL}
Built on Sentinel. https://sentinel.co


wallet     status | generate | import --file <keyfile> | logout | balance (alias show) | qr | send --to <addr> --amount <n> [--asset SOL|TDVPN]
provider   list [--all] [--fresh] | daemon | select <pda> | register --uri https://host:port | status [--delisted] | close | unbonding | withdraw-bond
plan       list [--all] [--fresh] | show <pda> | create --duration <s> [--price <tDVPN>] [--cap <GB>] [--max <n>] [--no-list]
           update <pda> [--price|--duration|--cap|--max] | status <pda> [--delisted] | close <pda> | members <pda> | subscriptions <pda> | share <pda> [--for <addr>]
subscriber subscribe <plan> | own <plan> | add <plan> <addr> | add-many <plan> <addr...> | close <subscription> | ticket <plan> --node <node>
nodes      list [--page --limit --search --country --protocol --plan <pda> --exclude-in-plan --in-plan --all --refresh] | count | rankings | progress
           link <plan> <node...> | unlink <plan> <node...>
lease      list | keep | end <lease> [--force]
earnings   show [--fresh] | withdraw-revenue [--amount <tDVPN>] | withdraw-balance | sweep-fees | withdraw-user-balance
params     show | price      rpc show      health show | daemons      wallet privy-config      feegrant status (work in progress)

flags: --json  --base-url <url>  --session <file>  -h      (a value that starts with -- must be given as --flag=value)`;

async function main() {
  const [group, cmd] = positional;
  if (flags.help || !group) { out(HELP); return; }
  const g = commands[group];
  if (!g) fail(`unknown group "${group}"\n\n${HELP}`);
  const fn = cmd === undefined ? (g.list || g.show) : g[cmd];
  if (!fn) fail(`unknown command "${group} ${cmd}"\n\n${HELP}`);
  const data = await fn();
  show(data);
}
main().catch((e) => fail(e.message));
