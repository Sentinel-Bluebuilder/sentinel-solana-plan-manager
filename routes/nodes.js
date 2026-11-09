// ─── Nodes, roster (link/unlink) and leases ──────────────────────────────────
// Discovery is on-chain (Node accounts). Linking is the provider daemon's
// roster; its lease keeper opens, funds and closes the leases those bindings
// need — this console never opens a lease for a roster node.
import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { route, httpError, pubkeyArg, requireSession, requireProvider, assertPlanOwnership } from '../lib/http.js';
import { allNodes, leasesByProvider, leaseByPda, tdvpn } from '../lib/solana/accounts.js';
import { ix, fetchConfig } from '../lib/solana/program.js';
import { LEASE_STATUS_OPEN, LEASE_STATUS_CLOSING, MODE_VOUCHER, MODE_STREAM } from '../lib/solana/idl.js';
import { broadcastOrRelay } from '../lib/solana/tx.js';
import { providerDaemonChecked, providerDaemon } from '../lib/daemon.js';
import { health as probeHealth } from '../lib/nodeapi.js';
import { cached, cacheInvalidate } from '../lib/cache.js';
import { invalidateProviders } from '../lib/wallet.js';
import { NODE_CACHE_TTL, NODE_PROBE_TIMEOUT_MS, MAX_BATCH_NODES, DATA_DIR } from '../lib/constants.js';
import { shapeNode } from './plans.js';

const r = Router();
const CACHE_FILE = join(DATA_DIR, 'nodes-cache.json');
let catalog = { fetchedAt: 0, nodes: [], probing: false };

function loadDisk() {
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      if (raw && Array.isArray(raw.nodes)) catalog = { ...raw, probing: false };
    }
  } catch (err) {
    console.warn(`[nodes] nodes-cache.json unreadable, ignoring: ${err.message}`);
  }
}
loadDisk();

function saveDisk() {
  try { writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: catalog.fetchedAt, nodes: catalog.nodes }), 'utf8'); } catch (err) {
    console.warn(`[nodes] failed to persist nodes cache: ${err.message}`);
  }
}

async function probeNodes(nodes) {
  if (catalog.probing) return;
  catalog.probing = true;
  try {
    const targets = nodes.filter((n) => n.live && n.uri);
    const limit = 8;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, async () => {
      while (i < targets.length) {
        const n = targets[i++];
        const t0 = Date.now();
        try {
          const h = await probeHealth(n.uri, { timeoutMs: NODE_PROBE_TIMEOUT_MS });
          n.health = { ok: h.status === 200, status: h.status, latencyMs: Date.now() - t0, checkedAt: Math.floor(Date.now() / 1000) };
        } catch (err) {
          n.health = { ok: false, error: err.message.slice(0, 80), latencyMs: Date.now() - t0, checkedAt: Math.floor(Date.now() / 1000) };
        }
      }
    }));
    saveDisk();
  } finally {
    catalog.probing = false;
  }
}

/** Fresh catalog from chain (cached NODE_CACHE_TTL; stale copy served while refreshing). */
export async function nodeCatalog({ force = false } = {}) {
  const stale = Date.now() - catalog.fetchedAt > NODE_CACHE_TTL;
  if (!force && !stale) return catalog.nodes;
  const refresh = cached('nodes:refresh', 5000, async () => {
    const cfg = await fetchConfig();
    const raw = await allNodes();
    const prev = new Map(catalog.nodes.map((n) => [n.address, n]));
    const nodes = raw.map((n) => ({ ...shapeNode(n, cfg), health: prev.get(n.address)?.health || null }));
    catalog = { fetchedAt: Date.now(), nodes, probing: catalog.probing };
    saveDisk();
    probeNodes(nodes).catch((err) => console.warn(`[nodes] probe failed: ${err.message}`));
    return nodes;
  });
  if (force || !catalog.nodes.length) return refresh;
  refresh.catch((err) => console.warn(`[nodes] background refresh failed: ${err.message}`));
  return catalog.nodes;
}

async function rosterSet(providerPda, planPda) {
  try {
    const rows = await providerDaemon(providerPda).listRoster();
    return new Map(rows.filter((x) => !planPda || x.plan === planPda).map((x) => [x.node, x]));
  } catch (err) {
    if (err.status !== 503) console.warn(`[nodes] roster read for ${providerPda} failed: ${err.message}`);
    return null;
  }
}

r.get('/api/all-nodes', route(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
  const search = String(req.query.search || '').toLowerCase();
  const country = String(req.query.country || '').toUpperCase();
  const protocol = String(req.query.protocol || '').toLowerCase();
  const planId = req.query.planId ? pubkeyArg(req.query.planId, 'planId').toBase58() : null;
  const excludeInPlan = req.query.excludeInPlan === 'true';
  const inPlanOnly = req.query.inPlanOnly === 'true';
  const listedOnly = req.query.listedOnly !== 'false';

  const all = await nodeCatalog({ force: req.query.refresh === '1' });
  let roster = null;
  if (planId) {
    const provider = await requireProvider().then((p) => p.address).catch(() => null);
    roster = provider ? await rosterSet(provider, planId) : null;
  }
  let filtered = all.map((n) => ({ ...n, inPlan: roster ? roster.has(n.address) : false, rosterLive: roster?.get(n.address)?.live ?? null }));
  if (listedOnly) filtered = filtered.filter((n) => n.listed);
  if (excludeInPlan && roster) filtered = filtered.filter((n) => !roster.has(n.address));
  if (inPlanOnly && roster) filtered = filtered.filter((n) => roster.has(n.address));
  if (search) filtered = filtered.filter((n) => n.address.toLowerCase().includes(search) || (n.uri || '').toLowerCase().includes(search) || (n.country || '').toLowerCase().includes(search));
  if (country) filtered = filtered.filter((n) => n.country === country);
  if (protocol) filtered = filtered.filter((n) => n.protocols.includes(protocol));
  const countries = {};
  for (const n of filtered) countries[n.country] = (countries[n.country] || 0) + 1;
  const start = (page - 1) * limit;
  res.json({
    nodes: filtered.slice(start, start + limit), total: filtered.length, totalNodes: all.length, page, limit,
    pages: Math.max(1, Math.ceil(filtered.length / limit)), countries, fetchedAt: catalog.fetchedAt, rosterAvailable: roster !== null,
  });
}));

r.get('/api/nodes/progress', (req, res) => res.json({ scanning: catalog.probing, total: catalog.nodes.length, fetchedAt: catalog.fetchedAt, done: !catalog.probing }));
r.get('/api/nodes/chain-count', route(async (req, res) => {
  const all = await nodeCatalog();
  res.json({ count: all.length, listed: all.filter((n) => n.listed).length, live: all.filter((n) => n.live).length });
}));

r.get('/api/node-rankings', route(async (req, res) => {
  const all = (await nodeCatalog()).filter((n) => n.live);
  const byLease = [...all].sort((a, b) => Number(BigInt(a.leasePricePerHour) - BigInt(b.leasePricePerHour)));
  res.json({ cheapestLease: byLease.slice(0, 20), count: all.length, median: byLease.length ? byLease[Math.floor(byLease.length / 2)].leasePerHourTdvpn : null });
}));

// ─── roster ──────────────────────────────────────────────────────────────────
async function rosterMutation(req, res, op) {
  const plan = await assertPlanOwnership(req.body?.planId);
  const raw = req.body?.nodeAddresses ?? (req.body?.nodeAddress ? [req.body.nodeAddress] : null);
  if (!Array.isArray(raw) || !raw.length) throw httpError(400, 'nodeAddress or nodeAddresses[] required', 'missing-field');
  if (raw.length > MAX_BATCH_NODES) throw httpError(400, `At most ${MAX_BATCH_NODES} nodes per request`, 'batch-too-large');
  const nodes = [...new Set(raw.map((a) => pubkeyArg(a, 'nodeAddress').toBase58()))];
  const { daemon } = await providerDaemonChecked(plan.provider);
  if (op === 'add') await daemon.addRoster(plan.address, nodes); else await daemon.removeRoster(plan.address, nodes);
  const roster = (await daemon.listRoster()).filter((x) => x.plan === plan.address);
  cacheInvalidate(`plans:provider:${plan.provider}`);
  res.json({ ok: true, planId: plan.address, op, nodes, roster, totalNodes: roster.length, note: op === 'add' ? 'The provider daemon opens and funds the lease for each node on its next keeper tick.' : 'The provider daemon closes the lease once no plan references the node.' });
}
r.post('/api/plan-manager/link', route((req, res) => rosterMutation(req, res, 'add')));
r.post('/api/plan-manager/batch-link', route((req, res) => rosterMutation(req, res, 'add')));
r.post('/api/plan-manager/unlink', route((req, res) => rosterMutation(req, res, 'remove')));
r.post('/api/plan-manager/batch-unlink', route((req, res) => rosterMutation(req, res, 'remove')));

// ─── leases ──────────────────────────────────────────────────────────────────
function shapeLease(l, cfg) {
  const grace = cfg?.leaseCloseGraceSeconds ? Number(cfg.leaseCloseGraceSeconds) : 7200;
  const closeStarted = Number(l.closeStartedAt || 0);
  return {
    address: l.address, provider: l.provider, node: l.node, owner: l.owner, opener: l.opener,
    mode: l.mode, modeName: l.mode === MODE_STREAM ? 'stream' : 'voucher', status: l.status,
    statusName: l.status === LEASE_STATUS_CLOSING ? 'closing' : 'open', ratePerHour: l.ratePerHour, ratePerHourTdvpn: tdvpn(l.ratePerHour),
    escrow: l.escrow, escrowTdvpn: tdvpn(l.escrow), redeemed: l.redeemed, redeemedTdvpn: tdvpn(l.redeemed),
    remaining: (BigInt(l.escrow) - BigInt(l.redeemed)).toString(), openedAt: Number(l.openedAt), closeStartedAt: closeStarted,
    closableAt: closeStarted ? closeStarted + grace : null, rentRecipient: l.rentRecipient,
  };
}

r.get('/api/leases', route(async (req, res) => {
  const { address: provider } = await requireProvider();
  const cfg = await fetchConfig();
  const chain = (await leasesByProvider(provider)).map((l) => shapeLease(l, cfg));
  let daemon = null;
  try { daemon = await providerDaemon(provider).listLeases(); } catch (err) {
    if (err.status !== 503) console.warn(`[leases] daemon ListLeases for ${provider} failed: ${err.message}`);
    daemon = null;
  }
  res.json({ provider, leases: chain, daemon, daemonAvailable: daemon !== null });
}));

async function keepNow(req, res) {
  const { address: provider } = await requireProvider();
  const { daemon } = await providerDaemonChecked(provider);
  await daemon.keepNow();
  res.json({ ok: true, provider, note: 'Lease keeper ran: leases for roster nodes were opened / topped up / closed as needed.' });
}
r.post('/api/lease/keep', route(keepNow));

/** Manual close of a chain lease the roster no longer references. Mode-aware (docs/21). */
r.post('/api/lease/end', route(async (req, res) => {
  const s = requireSession();
  const { address: provider } = await requireProvider();
  const lease = await leaseByPda(pubkeyArg(req.body?.lease ?? req.body?.leaseId, 'lease'));
  if (!lease) throw httpError(404, 'Lease not found on chain', 'lease-not-found');
  if (lease.provider !== provider) throw httpError(403, 'Lease belongs to another provider', 'not-lease-owner');
  // The keeper owns leases for roster nodes: closing one here would cut that
  // node out of its plans until the keeper reopens it. Unlink first.
  const roster = await rosterSet(provider, null);
  if (roster && roster.has(lease.node) && req.body?.force !== true) {
    const plans = [...new Set((await providerDaemon(provider).listRoster()).filter((x) => x.node === lease.node).map((x) => x.plan))];
    throw httpError(409, `Node ${lease.node} is still on the roster of ${plans.length} plan(s); unlink it first and the keeper closes the lease`, 'lease-in-roster');
  }
  const cfg = await fetchConfig();
  const nowS = Math.floor(Date.now() / 1000);
  let built; let step;
  if (lease.mode === MODE_STREAM) {
    built = await ix.closeLease({ signer: s.pubkey, provider, lease: lease.address, leaseAcct: lease }); step = 'closed';
  } else if (lease.status === LEASE_STATUS_OPEN) {
    built = await ix.startCloseLease({ signer: s.pubkey, provider, lease: lease.address }); step = 'close-started';
  } else {
    const closableAt = Number(lease.closeStartedAt) + Number(cfg.leaseCloseGraceSeconds);
    if (nowS < closableAt) throw httpError(409, `Grace window not elapsed — closable in ${closableAt - nowS}s`, 'grace-not-elapsed');
    built = await ix.closeLease({ signer: s.pubkey, provider, lease: lease.address, leaseAcct: lease }); step = 'closed';
  }
  const out = await broadcastOrRelay([built], res, `lease:${step}`, { lease: lease.address, step, mode: lease.mode === MODE_VOUCHER ? 'voucher' : 'stream' });
  if (out.relayed) return;
  invalidateProviders();
  res.json({ ...out.result, lease: lease.address, step, mode: lease.mode === MODE_VOUCHER ? 'voucher' : 'stream' });
}));

export default r;
