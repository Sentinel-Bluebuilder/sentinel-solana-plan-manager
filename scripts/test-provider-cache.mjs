#!/usr/bin/env node
// ─── Provider-list cache test ────────────────────────────────────────────────
// Offline. A fake JSON-RPC serves the captured devnet provider account and counts
// calls, proving getOwnedProviders() runs the costly owner search
// (getProgramAccounts) only to discover the set, and re-reads known providers by
// address (getAccountInfo) on every other refresh.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fix = JSON.parse(readFileSync(join(here, '..', 'test', 'fixtures', 'devnet-accounts.json'), 'utf8')).provider;

let pass = 0;
let fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── Fake RPC ────────────────────────────────────────────────────────────────
const calls = { getProgramAccounts: 0, getAccountInfo: 0 };
let vanished = false;
let programId = null;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const { id, method } = JSON.parse(body);
    calls[method] = (calls[method] || 0) + 1;
    const account = { data: [fix.data, 'base64'], executable: false, lamports: 1_000_000, owner: programId, rentEpoch: 0, space: Buffer.from(fix.data, 'base64').length };
    let result;
    if (method === 'getProgramAccounts') result = [{ pubkey: fix.address, account }];
    else if (method === 'getAccountInfo') result = { context: { slot: 1 }, value: vanished ? null : account };
    else result = null;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});
await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
process.env.SOLANA_RPC_URLS = `http://127.0.0.1:${srv.address().port}`;

const { PROGRAM_ID } = await import('../lib/solana/idl.js');
programId = PROGRAM_ID.toBase58();
const { decodeAccount } = await import('../lib/solana/accounts.js');
const owner = decodeAccount('provider', Buffer.from(fix.data, 'base64')).owner;
const { sessionFromWallet, runWithSession } = await import('../lib/session.js');
const { getOwnedProviders, getActiveProvider, invalidateProviders } = await import('../lib/wallet.js');

const snap = () => ({ ...calls });
const diff = (a) => ({ gpa: calls.getProgramAccounts - a.getProgramAccounts, one: calls.getAccountInfo - a.getAccountInfo });

console.log('provider cache:');
await runWithSession(sessionFromWallet(owner), async () => {
  let a = snap(); let list = await getOwnedProviders(); let d = diff(a);
  ok(list.length === 1 && list[0].address === fix.address, 'first load finds the provider');
  ok(d.gpa === 1 && d.one === 0, 'first load = one owner search', JSON.stringify(d));

  a = snap(); await getOwnedProviders(); d = diff(a);
  ok(d.gpa === 0 && d.one === 0, 'within 60 s: no chain call', JSON.stringify(d));

  a = snap(); list = await getOwnedProviders({ fresh: true }); d = diff(a);
  ok(d.gpa === 0 && d.one === 1 && list.length === 1, 'fresh = re-read by address, no owner search', JSON.stringify(d));

  invalidateProviders();
  a = snap(); const active = await getActiveProvider(); d = diff(a);
  ok(active === fix.address && d.gpa === 0 && d.one === 1, 'after a data write: re-read by address', JSON.stringify(d));

  invalidateProviders({ rediscover: true });
  a = snap(); await getOwnedProviders(); d = diff(a);
  ok(d.gpa === 1 && d.one === 0, 'after open/close/relay: owner search again', JSON.stringify(d));

  vanished = true;
  a = snap(); await getOwnedProviders({ fresh: true }); d = diff(a);
  ok(d.one === 1 && d.gpa === 1, 'a known provider vanished: falls back to the owner search', JSON.stringify(d));
  vanished = false;
});

srv.close();
console.log(`provider cache: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
