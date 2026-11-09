// ─── Provider (register / list / close / bond) ───────────────────────────────
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { route, httpError, pubkeyArg, requireSession, requireProvider } from '../lib/http.js';
import { getOwnedProviders, getActiveProvider, setActiveProvider, invalidateProviders } from '../lib/wallet.js';
import { ix, pda, fetchConfig } from '../lib/solana/program.js';
import { allProviders, fetchMany, tdvpn } from '../lib/solana/accounts.js';
import { OFFSETS } from '../lib/solana/idl.js';
import { broadcastOrRelay } from '../lib/solana/tx.js';
import { daemonsHealth, daemonTargets } from '../lib/daemon.js';
import { cached, cacheInvalidate } from '../lib/cache.js';
import { currentSession } from '../lib/session.js';

const r = Router();

function shapeProvider(p, cfg) {
  const unbonding = cfg?.unbondingSeconds ? Number(cfg.unbondingSeconds) : 3600;
  return {
    address: p.address, owner: p.owner, providerId: p.providerId, status: p.status, listed: p.status === 1,
    uri: p.uri, bond: p.bond, bondTdvpn: tdvpn(p.bond), revenue: p.revenue, revenueTdvpn: tdvpn(p.revenue),
    feesAccrued: p.feesAccrued, balance: p.balance, balanceTdvpn: tdvpn(p.balance),
    openPlans: p.openPlans, openLeases: p.openLeases, rentRecipient: p.rentRecipient, openedAt: Number(p.openedAt),
    unbondingSeconds: unbonding, daemonConfigured: daemonTargets().has(p.address),
  };
}

r.get('/api/providers', route(async (req, res) => {
  const cfg = await fetchConfig();
  if (req.query.all === '1' || req.query.all === 'true') {
    const list = await cached('providers:all', 60_000, () => allProviders());
    return res.json({ providers: list.map((p) => shapeProvider(p, cfg)) });
  }
  requireSession();
  const owned = await getOwnedProviders({ fresh: req.query.fresh === '1' });
  const active = await getActiveProvider();
  res.json({ providers: owned.map((p) => shapeProvider(p, cfg)), active, minProviderBond: cfg.minProviderBond.toString(), minProviderBondTdvpn: tdvpn(cfg.minProviderBond.toString()) });
}));

r.get('/api/providers/daemon', route(async (req, res) => {
  const health = (await daemonsHealth()).map((d) => (currentSession() ? d : { providerPda: d.providerPda, ok: d.ok }));
  const active = (await getActiveProvider().catch(() => null)) || null;
  res.json({ daemons: health, active, activeDaemon: health.find((h) => h.providerPda === active) || null });
}));

r.post('/api/provider/select', route(async (req, res) => {
  requireSession();
  const target = pubkeyArg(req.body?.provider, 'provider').toBase58();
  const owned = await getOwnedProviders({ fresh: true });
  if (!owned.some((p) => p.address === target)) throw httpError(403, 'That provider is not owned by this wallet', 'not-provider-owner');
  setActiveProvider(target);
  res.json({ ok: true, active: target });
}));

/**
 * Register (open + list in ONE tx) when the wallet owns no provider; otherwise
 * update the URI and/or list it (register-or-update).
 */
r.post('/api/provider/register', route(async (req, res) => {
  const s = requireSession();
  const uri = String(req.body?.uri || '').trim();
  if (!uri) throw httpError(400, 'uri required (the provider daemon\'s public https://host:port)', 'missing-field');
  if (Buffer.byteLength(uri) > 128) throw httpError(400, 'uri must be ≤ 128 bytes', 'invalid-field');
  if (!/^https:\/\//.test(uri)) throw httpError(400, 'uri must start with https://', 'invalid-field');
  const cfg = await fetchConfig();
  const owned = await getOwnedProviders({ fresh: true });
  const active = await getActiveProvider();
  const existing = owned.find((p) => p.address === active) || owned[0];
  const ixs = [];
  let provider;
  if (!existing) {
    const providerId = randomBytes(32);
    provider = pda.provider(s.pubkey, providerId).toBase58();
    ixs.push(await ix.openProvider({ signer: s.pubkey, providerId, uri, bond: cfg.minProviderBond }));
    ixs.push(await ix.listProvider({ signer: s.pubkey, provider }));
  } else {
    provider = existing.address;
    if (existing.uri !== uri) ixs.push(await ix.updateProvider({ signer: s.pubkey, provider, uri }));
    if (existing.status !== 1) ixs.push(await ix.listProvider({ signer: s.pubkey, provider }));
    if (!ixs.length) return res.json({ ok: true, provider, unchanged: true });
  }
  const out = await broadcastOrRelay(ixs, res, existing ? 'provider:update' : 'provider:register', { provider });
  if (out.relayed) return;
  invalidateProviders({ rediscover: !existing });
  cacheInvalidate('providers:all');
  setActiveProvider(provider);
  res.json({ ...out.result, provider, registered: !existing, bond: existing ? undefined : cfg.minProviderBond.toString() });
}));

r.post('/api/provider/status', route(async (req, res) => {
  const s = requireSession();
  const { address } = await requireProvider({ fresh: true });
  const status = Number(req.body?.status);
  if (![0, 1].includes(status)) throw httpError(400, 'status must be 1 (listed) or 0 (delisted)', 'invalid-field');
  const built = status === 1 ? await ix.listProvider({ signer: s.pubkey, provider: address }) : await ix.delistProvider({ signer: s.pubkey, provider: address });
  const out = await broadcastOrRelay([built], res, status === 1 ? 'provider:list' : 'provider:delist', { provider: address, status });
  if (out.relayed) return;
  invalidateProviders();
  cacheInvalidate('providers:all');
  res.json({ ...out.result, provider: address, status });
}));

r.post('/api/provider/close', route(async (req, res) => {
  const s = requireSession();
  const { address, account } = await requireProvider({ fresh: true });
  if (account.openPlans > 0) throw httpError(409, `Close the provider's ${account.openPlans} open plan(s) first`, 'open-plans-remain');
  if (account.openLeases > 0) throw httpError(409, `Close the provider's ${account.openLeases} open lease(s) first`, 'open-leases-remain');
  const ixs = [];
  if (account.status === 1) ixs.push(await ix.delistProvider({ signer: s.pubkey, provider: address }));
  ixs.push(await ix.closeProvider({ signer: s.pubkey, provider: address, providerAcct: { ...account, providerId: Buffer.from(account.providerId, 'hex') } }));
  const out = await broadcastOrRelay(ixs, res, 'provider:close', { provider: address, closed: true });
  if (out.relayed) return;
  invalidateProviders({ rediscover: true });
  cacheInvalidate('providers:all');
  res.json({ ...out.result, provider: address, closed: true, unbondingSeconds: Number((await fetchConfig()).unbondingSeconds) });
}));

/** Parked bonds for this owner (after close_provider), with maturity. */
export async function unbondingForOwner(owner) {
  const cfg = await fetchConfig();
  const rows = await fetchMany('providerUnbonding', [{ offset: OFFSETS.providerUnbonding.owner, pubkey: owner }], { label: 'unbonding:owner' });
  const now = Math.floor(Date.now() / 1000);
  return rows.map((u) => {
    const matureAt = Number(u.closedAt) + Number(cfg.unbondingSeconds);
    return { ...u, amount: u.bond, amountTdvpn: tdvpn(u.bond), matureAt, matured: now >= matureAt, secondsLeft: Math.max(0, matureAt - now) };
  });
}

r.get('/api/provider/unbonding', route(async (req, res) => {
  const s = requireSession();
  res.json({ unbonding: await unbondingForOwner(s.address) });
}));

r.post('/api/provider/withdraw-bond', route(async (req, res) => {
  const s = requireSession();
  const list = await unbondingForOwner(s.address);
  const matured = list.filter((u) => u.matured);
  if (!matured.length) {
    if (list.length) throw httpError(409, `Bond still unbonding — ${list[0].secondsLeft}s left`, 'unbonding-not-elapsed');
    throw httpError(404, 'No parked bond to withdraw', 'no-unbonding');
  }
  const ixs = [];
  for (const u of matured) ixs.push(await ix.withdrawProviderBond({ signer: s.pubkey, unbonding: { ...u, providerId: Buffer.from(u.providerId, 'hex') } }));
  const out = await broadcastOrRelay(ixs, res, 'provider:withdraw-bond', { withdrawn: matured.map((u) => ({ amount: u.amount, amountTdvpn: u.amountTdvpn })) });
  if (out.relayed) return;
  cacheInvalidate(`balance:${s.address}`);
  res.json({ ...out.result, withdrawn: matured.map((u) => ({ amount: u.amount, amountTdvpn: u.amountTdvpn })) });
}));

export default r;
