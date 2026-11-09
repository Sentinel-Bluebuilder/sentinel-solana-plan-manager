#!/usr/bin/env node
// ─── smoke: exercise the chain layer read-only against live devnet ───────────
// node scripts/dev/smoke.mjs   (needs .env; spends nothing — simulation only)
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { NETWORK, PROGRAM_ID, MINT, DEPLOYED_SIZES, ACCOUNT_NAMES } from '../../lib/solana/idl.js';
import { getRpcState } from '../../lib/solana/rpc.js';
import { coder, ix, pda, fetchConfig } from '../../lib/solana/program.js';
import * as acc from '../../lib/solana/accounts.js';
import { buildTx } from '../../lib/solana/tx.js';
import { describeProgramError, ProgramError } from '../../lib/solana/errors.js';
import * as nodeapi from '../../lib/nodeapi.js';
import { daemonsHealth } from '../../lib/daemon.js';
import { keypairFromInput, sessionFromKeypair, runWithSession } from '../../lib/session.js';

const t0 = Date.now();
const step = (name, v) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${name}:`, typeof v === 'string' ? v : JSON.stringify(v));

step('network', { NETWORK, programId: PROGRAM_ID.toBase58(), mint: MINT.toBase58() });
for (const n of ACCOUNT_NAMES) {
  const s = coder().size(n);
  if (DEPLOYED_SIZES && s !== DEPLOYED_SIZES[n]) throw new Error(`coder size ${n}=${s} != deployed ${DEPLOYED_SIZES[n]}`);
}
step('idl sizes', 'all match deployed table');
step('rpc', await getRpcState());

const cfg = await fetchConfig();
step('config', { feeBps: cfg.feeBps, minProviderBond: cfg.minProviderBond.toString(), vault: cfg.vault.toBase58(), paused: cfg.paused });

const keyfile = process.env.TEST_KEYFILE;
const kp = keyfile ? keypairFromInput(readFileSync(keyfile, 'utf8')) : Keypair.generate();
step('test wallet', kp.publicKey.toBase58());

const providers = await acc.providersByOwner(kp.publicKey);
step('providers by owner', providers.map((p) => ({ address: p.address, status: p.status, bond: p.bond, revenue: p.revenue, uri: p.uri, openPlans: p.openPlans, openLeases: p.openLeases })));
const prov = providers[0];
if (prov) {
  const plans = await acc.plansByProvider(prov.address);
  step('plans', plans.map((p) => ({ address: p.address, price: p.price, status: p.status, dur: p.durationSeconds, cap: p.dataCapGb, max: p.maxConnections })));
  const leases = await acc.leasesByProvider(prov.address);
  step('leases', leases.map((l) => ({ address: l.address, node: l.node, status: l.status, mode: l.mode, escrow: l.escrow, redeemed: l.redeemed, voucherSigner: l.voucherSigner })));
  if (plans[0]) {
    const subs = await acc.subscriptionsByPlan(plans[0].address);
    step('subs of plan0', subs.length);
  }
}
const nodes = await acc.allNodes();
step('nodes', nodes.map((n) => ({ address: n.address, status: n.status, leasePerHour: n.leasePricePerHour, protocols: n.protocolNames, country: n.country, uri: n.uri, listedAt: n.listedAt })));
const user = await acc.userByOwner(kp.publicKey);
step('user account', user ? { balance: user.balance, openChannels: user.openChannels } : null);

// ── build + simulate open_plan (never sent) ──
if (prov) {
  const planId = Buffer.alloc(32, 7);
  const ixs = [
    await ix.openPlan({ signer: kp.publicKey, provider: prov.address, planId, price: '1000', durationSeconds: 3600, dataCapGb: 1, maxConnections: 1 }),
    await ix.listPlan({ signer: kp.publicKey, provider: prov.address, plan: pda.plan(prov.address, planId) }),
  ];
  const built = await buildTx(ixs, kp.publicKey, { label: 'smoke:open+list' });
  step('simulated open_plan+list_plan', { unitsConsumed: built.unitsConsumed, priorityFee: built.priorityFee, txBytes: built.tx.serialize().length });
  // a doomed one: list a plan that does not exist → expect a decoded error
  try {
    await buildTx([await ix.listPlan({ signer: kp.publicKey, provider: prov.address, plan: Keypair.generate().publicKey })], kp.publicKey, { label: 'smoke:doomed' });
    step('doomed listPlan', 'UNEXPECTEDLY simulated OK');
  } catch (e) {
    step('doomed listPlan', e instanceof ProgramError ? `ProgramError code=${e.code} ${e.message}` : `other: ${e.message}`);
  }
}
step('error table samples', [6023, 6034, 6036, 6040].map((c) => describeProgramError(c)));

// ── signing vectors (local round-trip) ──
const hdrs = nodeapi.signRequest(kp, 'POST', '/v1/tickets', Buffer.from('{"a":1}'));
const msg = nodeapi.requestMessage('POST', '/v1/tickets', Buffer.from('{"a":1}'), Number(hdrs['X-Sentinel-Timestamp']), Buffer.from(hdrs['X-Sentinel-Nonce'], 'base64'));
step('request sig verifies', nodeapi.verifyDomain(kp.publicKey, nodeapi.DOMAIN_API_REQUEST, msg, Buffer.from(hdrs['X-Sentinel-Signature'], 'base64')));
const tr = nodeapi.signTicketRequest(kp, { subscription: kp.publicKey, node: kp.publicKey, provider: kp.publicKey });
step('ticket request wire bytes', Buffer.from(tr, 'base64').length);

// ── session plumbing ──
await runWithSession(sessionFromKeypair(kp), async () => {
  const { currentSession } = await import('../../lib/session.js');
  step('session', { kind: currentSession().kind, address: currentSession().address });
});

step('daemons', await daemonsHealth());
step('done', 'ok');
