// ─── Plans ───────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { route, httpError, pubkeyArg, intArg, rateLimit, requireSession, requireProvider, assertPlanOwnership } from '../lib/http.js';
import { parseChainError } from '../lib/errors.js';
import { getActiveProvider, invalidateProviders } from '../lib/wallet.js';
import { ix, pda } from '../lib/solana/program.js';
import { allPlans, planByPda, plansByProvider, subscriptionsByPlan, subscriptionByOwnerPlan, tdvpn, toBaseUnits, baseUnitsArg, nodeByPda } from '../lib/solana/accounts.js';
import { broadcastOrRelay } from '../lib/solana/tx.js';
import { cached, cacheInvalidate, cacheInvalidatePrefix } from '../lib/cache.js';
import { providerDaemon } from '../lib/daemon.js';
import { readBalances } from './wallet.js';

const r = Router();
const now = () => Math.floor(Date.now() / 1000);

export function shapePlan(p) {
  return {
    planId: p.address, address: p.address, provider: p.provider, planIdHex: p.planId,
    price: p.price, priceTdvpn: tdvpn(p.price), free: BigInt(p.price) === 0n,
    durationSeconds: p.durationSeconds, durationDays: Math.round((p.durationSeconds / 86400) * 100) / 100,
    dataCapGb: p.dataCapGb, unlimited: p.dataCapGb === 0, maxConnections: p.maxConnections,
    status: p.status, listed: p.status === 1, rentRecipient: p.rentRecipient,
  };
}

export function shapeSubscription(s) {
  const t = now();
  return {
    subscriptionId: s.address, address: s.address, owner: s.owner, plan: s.plan, provider: s.provider,
    price: s.price, priceTdvpn: tdvpn(s.price), openedAt: Number(s.openedAt), expiresAt: Number(s.expiresAt),
    active: Number(s.expiresAt) > t, secondsLeft: Math.max(0, Number(s.expiresAt) - t),
    dataCapGb: s.dataCapGb, maxConnections: s.maxConnections, rentRecipient: s.rentRecipient,
  };
}

/** Roster rows for a plan from the provider daemon (null when no daemon). */
export async function rosterForPlan(providerPda, planPda) {
  try {
    const d = providerDaemon(providerPda);
    const rows = await d.listRoster();
    return rows.filter((n) => n.plan === planPda);
  } catch (err) {
    if (err.status === 503 || err.grpcCode !== undefined) return null;
    throw err;
  }
}

export async function planStats(plan, providerPda) {
  const subs = await cached(`subs:${plan.address}`, 30_000, () => subscriptionsByPlan(plan.address));
  const shaped = subs.map(shapeSubscription);
  const active = shaped.filter((s) => s.active).length;
  const roster = providerPda ? await rosterForPlan(providerPda, plan.address) : null;
  const gross = subs.reduce((a, s) => a + BigInt(s.price), 0n);
  return {
    ...shapePlan(plan),
    totalSubscriptions: shaped.length, activeSubs: active, inactiveSubs: shaped.length - active,
    totalNodes: roster ? roster.length : null, liveNodes: roster ? roster.filter((n) => n.live).length : null, rosterAvailable: roster !== null,
    grossRevenue: gross.toString(), grossRevenueTdvpn: tdvpn(gross.toString()),
    earliestStart: shaped.length ? Math.min(...shaped.map((s) => s.openedAt)) : null,
    latestStart: shaped.length ? Math.max(...shaped.map((s) => s.openedAt)) : null,
  };
}

r.get('/api/plans', route(async (req, res) => {
  const list = await cached('plans:all', 60_000, () => allPlans());
  res.json({ plans: list.map(shapePlan) });
}));

r.get('/api/my-plans', route(async (req, res) => {
  const s = requireSession();
  const fresh = req.query.fresh === '1';
  const provider = await getActiveProvider({ fresh });
  // fresh=1 drops only THIS operator's cached reads; the global plans:/subs: caches stay for everyone else.
  if (fresh) { if (provider) cacheInvalidate(`plans:provider:${provider}`); cacheInvalidate(`balance:${s.address}`); }
  const [bal, plans] = await Promise.all([
    cached(`balance:${s.address}`, 15_000, () => readBalances(s.address)),
    provider ? cached(`plans:provider:${provider}`, 30_000, () => plansByProvider(provider)) : [],
  ]);
  if (fresh) for (const p of plans) cacheInvalidate(`subs:${p.address}`);
  const stats = await Promise.all(plans.map((p) => planStats(p, provider).catch((err) => ({ ...shapePlan(p), _statsUnavailable: true, _error: parseChainError(err) }))));
  stats.sort((a, b) => (b.listed - a.listed) || a.address.localeCompare(b.address));
  res.json({ address: s.address, provider, balance: bal.tdvpn.amount, sol: bal.sol.amount, plans: stats, partialFailures: stats.filter((p) => p._statsUnavailable).length || undefined });
}));

// Per-id reads are one getProgramAccounts each on a cache key the caller picks, so they are limited per ip.
const PLAN_READ_LIMIT = rateLimit('planread', 120, 60_000);
r.get('/api/plans/:id', PLAN_READ_LIMIT, route(async (req, res) => {
  const plan = await planByPda(pubkeyArg(req.params.id, 'planId'));
  if (!plan) throw httpError(404, 'Plan not found on chain', 'plan-not-found');
  res.json(await planStats(plan, plan.provider));
}));

r.get('/api/plans/:id/subscriptions', PLAN_READ_LIMIT, route(async (req, res) => {
  const plan = pubkeyArg(req.params.id, 'planId').toBase58();
  const subs = await cached(`subs:${plan}`, 30_000, () => subscriptionsByPlan(plan));
  res.json({ plan, subscriptions: subs.map(shapeSubscription), total: subs.length });
}));

/** Subscribers + roster nodes for a plan (the "members" view). */
r.get('/api/plans/:id/members', PLAN_READ_LIMIT, route(async (req, res) => {
  const plan = await planByPda(pubkeyArg(req.params.id, 'planId'));
  if (!plan) throw httpError(404, 'Plan not found on chain', 'plan-not-found');
  const subs = await cached(`subs:${plan.address}`, 30_000, () => subscriptionsByPlan(plan.address));
  const roster = await rosterForPlan(plan.provider, plan.address);
  let nodes = [];
  if (roster && roster.length) {
    const wellFormed = roster.filter((row) => {
      try { pubkeyArg(row.node, 'node'); if (row.lease) pubkeyArg(row.lease, 'lease'); return true; } catch (err) {
        console.warn(`[plans] roster row with a malformed address ignored: ${JSON.stringify(row).slice(0, 120)}`);
        return false;
      }
    });
    nodes = await Promise.all(wellFormed.map(async (row) => {
      const n = await cached(`node:${row.node}`, 60_000, () => nodeByPda(row.node)).catch((err) => {
        console.warn(`[plans] node ${row.node} unreadable for members view: ${err.message}`);
        return null;
      });
      return { address: row.node, live: row.live, probedAt: Number(row.probedAt || 0), lease: row.lease || null, node: n ? shapeNode(n) : null };
    }));
  }
  res.json({ plan: shapePlan(plan), subscribers: subs.map(shapeSubscription), nodes, rosterAvailable: roster !== null });
}));

r.get('/api/plans/:id/own-subscription', route(async (req, res) => {
  const s = requireSession();
  const plan = pubkeyArg(req.params.id, 'planId');
  const sub = await subscriptionByOwnerPlan(s.pubkey, plan);
  res.json({ plan: plan.toBase58(), subscription: sub ? shapeSubscription(sub) : null, subscribed: !!sub });
}));

// ─── writes ──────────────────────────────────────────────────────────────────
function planArgs(body, { partial = false } = {}) {
  const out = {};
  const priceIn = body.priceTdvpn ?? body.price;
  if (priceIn !== undefined && priceIn !== null && priceIn !== '') out.price = body.priceTdvpn !== undefined ? toBaseUnits(body.priceTdvpn) : baseUnitsArg(body.price, 'price');
  else if (!partial) out.price = '0';
  if (body.durationSeconds !== undefined || !partial) out.durationSeconds = intArg(body.durationSeconds, 'durationSeconds', { min: 60, max: 4_294_967_295 });
  if (body.dataCapGb !== undefined || !partial) out.dataCapGb = intArg(body.dataCapGb, 'dataCapGb (0 = unlimited)', { min: 0, max: 4_294_967_295, fallback: partial ? undefined : 0 });
  if (body.maxConnections !== undefined || !partial) out.maxConnections = intArg(body.maxConnections, 'maxConnections', { min: 1, max: 255, fallback: partial ? undefined : 1 });
  return out;
}

r.post('/api/plan/create', route(async (req, res) => {
  const s = requireSession();
  const { address: provider, account } = await requireProvider({ fresh: true });
  if (account.status !== 1) throw httpError(409, 'Provider is delisted — list it before publishing plans', 'provider-not-listed');
  const a = planArgs(req.body || {});
  const planId = randomBytes(32);
  const plan = pda.plan(provider, planId).toBase58();
  const ixs = [await ix.openPlan({ signer: s.pubkey, provider, planId, ...a })];
  const list = req.body?.list !== false;
  if (list) ixs.push(await ix.listPlan({ signer: s.pubkey, provider, plan }));
  const out = await broadcastOrRelay(ixs, res, 'plan:create', { planId: plan });
  if (out.relayed) return;
  cacheInvalidatePrefix('plans:');
  invalidateProviders();
  res.json({ ...out.result, planId: plan, plan, listed: list, terms: { ...a, priceTdvpn: tdvpn(a.price) } });
}));

r.post('/api/plan/update', route(async (req, res) => {
  const s = requireSession();
  const plan = await assertPlanOwnership(req.body?.planId);
  const a = planArgs(req.body || {}, { partial: true });
  if (!Object.keys(a).length) throw httpError(400, 'Nothing to update', 'missing-field');
  const out = await broadcastOrRelay([await ix.updatePlan({ signer: s.pubkey, provider: plan.provider, plan: plan.address, ...a })], res, 'plan:update', { planId: plan.address, updated: a });
  if (out.relayed) return;
  cacheInvalidatePrefix('plans:');
  res.json({ ...out.result, planId: plan.address, updated: a });
}));

r.post('/api/plan/status', route(async (req, res) => {
  const s = requireSession();
  const plan = await assertPlanOwnership(req.body?.planId);
  const status = Number(req.body?.status);
  if (![0, 1].includes(status)) throw httpError(400, 'status must be 1 (listed) or 0 (delisted)', 'invalid-field');
  if (plan.status === status) return res.json({ ok: true, planId: plan.address, status, unchanged: true });
  const built = status === 1
    ? await ix.listPlan({ signer: s.pubkey, provider: plan.provider, plan: plan.address })
    : await ix.delistPlan({ signer: s.pubkey, provider: plan.provider, plan: plan.address });
  const out = await broadcastOrRelay([built], res, status === 1 ? 'plan:list' : 'plan:delist', { planId: plan.address, status });
  if (out.relayed) return;
  cacheInvalidatePrefix('plans:');
  res.json({ ...out.result, planId: plan.address, status });
}));

r.post('/api/plan/close', route(async (req, res) => {
  const s = requireSession();
  const plan = await assertPlanOwnership(req.body?.planId);
  const ixs = [];
  if (plan.status === 1) ixs.push(await ix.delistPlan({ signer: s.pubkey, provider: plan.provider, plan: plan.address }));
  ixs.push(await ix.closePlan({ signer: s.pubkey, provider: plan.provider, plan: plan.address, rentRecipient: plan.rentRecipient }));
  const out = await broadcastOrRelay(ixs, res, 'plan:close', { planId: plan.address });
  if (out.relayed) return;
  cacheInvalidatePrefix('plans:');
  cacheInvalidate(`subs:${plan.address}`);
  invalidateProviders();
  res.json({ ...out.result, planId: plan.address, closed: true });
}));

// shared with routes/nodes.js
export function shapeNode(n, cfg) {
  const ttl = cfg?.nodeListingTtlSeconds ? Number(cfg.nodeListingTtlSeconds) : 86400;
  const listedAt = Number(n.listedAt || 0);
  const expiresAt = listedAt ? listedAt + ttl : 0;
  return {
    address: n.address, owner: n.owner, nodeId: n.nodeId, status: n.status, listed: n.status === 1,
    live: n.status === 1 && expiresAt > now(), listedAt, expiresAt,
    country: n.country, protocols: n.protocolNames || [], protocol: (n.protocolNames || [])[0] || null, protocolMask: n.protocols,
    uri: n.uri, leasePricePerHour: n.leasePricePerHour, leasePerHourTdvpn: tdvpn(n.leasePricePerHour),
    channelPricePerGb: n.channelPricePerGb, channelPerGbTdvpn: tdvpn(n.channelPricePerGb),
    channelPricePerHour: n.channelPricePerHour, channelPerHourTdvpn: tdvpn(n.channelPricePerHour),
    bond: n.bond, revenue: n.revenue, feesAccrued: n.feesAccrued, openedAt: Number(n.openedAt),
  };
}

export default r;
