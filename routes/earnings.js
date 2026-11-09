// ─── Earnings (Solana-only: revenue / balance / fees / bond live on chain) ────
import { Router } from 'express';
import { route, httpError, requireSession, requireProvider } from '../lib/http.js';
import { ix, fetchConfig } from '../lib/solana/program.js';
import { userByOwner, tdvpn, toBaseUnits } from '../lib/solana/accounts.js';
import { broadcastOrRelay } from '../lib/solana/tx.js';
import { invalidateProviders } from '../lib/wallet.js';
import { cacheInvalidate } from '../lib/cache.js';
import { unbondingForOwner } from './provider.js';

const r = Router();

r.get('/api/earnings', route(async (req, res) => {
  const s = requireSession();
  const cfg = await fetchConfig();
  const [prov, user, unbonding] = await Promise.all([
    requireProvider({ fresh: req.query.fresh === '1' }).catch((err) => (err.status === 409 ? null : Promise.reject(err))),
    userByOwner(s.pubkey),
    unbondingForOwner(s.address),
  ]);
  const p = prov?.account || null;
  res.json({
    address: s.address,
    provider: p ? {
      address: p.address, status: p.status, revenue: p.revenue, revenueTdvpn: tdvpn(p.revenue), balance: p.balance, balanceTdvpn: tdvpn(p.balance),
      feesAccrued: p.feesAccrued, feesAccruedTdvpn: tdvpn(p.feesAccrued), bond: p.bond, bondTdvpn: tdvpn(p.bond), openPlans: p.openPlans, openLeases: p.openLeases,
    } : null,
    user: user ? { balance: user.balance, balanceTdvpn: tdvpn(user.balance), openChannels: user.openChannels } : null,
    unbonding,
    feeBps: cfg.feeBps, unbondingSeconds: Number(cfg.unbondingSeconds),
  });
}));

r.post('/api/earnings/withdraw-revenue', route(async (req, res) => {
  const s = requireSession();
  const { address, account } = await requireProvider({ fresh: true });
  const want = req.body?.amount === undefined || req.body?.amount === 'all' ? account.revenue : toBaseUnits(req.body.amount);
  if (BigInt(want) <= 0n) throw httpError(409, 'No revenue to withdraw', 'nothing-to-withdraw');
  if (BigInt(want) > BigInt(account.revenue)) throw httpError(400, `Only ${tdvpn(account.revenue)} tDVPN of revenue is available`, 'insufficient-revenue');
  const out = await broadcastOrRelay([await ix.withdrawProviderRevenue({ signer: s.pubkey, provider: address, owner: account.owner, amount: want })], res, 'earnings:revenue', { amount: want, amountTdvpn: tdvpn(want) });
  if (out.relayed) return;
  invalidateProviders(); cacheInvalidate(`balance:${s.address}`);
  res.json({ ...out.result, amount: want, amountTdvpn: tdvpn(want) });
}));

r.post('/api/earnings/withdraw-balance', route(async (req, res) => {
  const s = requireSession();
  const { address, account } = await requireProvider({ fresh: true });
  if (BigInt(account.balance) <= 0n) throw httpError(409, 'Provider balance is empty', 'nothing-to-withdraw');
  const out = await broadcastOrRelay([await ix.withdrawProviderBalance({ signer: s.pubkey, provider: address, owner: account.owner })], res, 'earnings:balance', { amount: account.balance, amountTdvpn: tdvpn(account.balance) });
  if (out.relayed) return;
  invalidateProviders(); cacheInvalidate(`balance:${s.address}`);
  res.json({ ...out.result, amount: account.balance, amountTdvpn: tdvpn(account.balance) });
}));

r.post('/api/earnings/sweep-fees', route(async (req, res) => {
  const s = requireSession();
  const { address, account } = await requireProvider({ fresh: true });
  if (BigInt(account.feesAccrued) <= 0n) throw httpError(409, 'No protocol fees accrued on this provider', 'nothing-to-sweep');
  const out = await broadcastOrRelay([await ix.sweepProviderFees({ signer: s.pubkey, providers: [address] })], res, 'earnings:sweep', { swept: account.feesAccrued, sweptTdvpn: tdvpn(account.feesAccrued) });
  if (out.relayed) return;
  invalidateProviders();
  res.json({ ...out.result, swept: account.feesAccrued, sweptTdvpn: tdvpn(account.feesAccrued) });
}));

r.post('/api/earnings/withdraw-user-balance', route(async (req, res) => {
  const s = requireSession();
  const user = await userByOwner(s.pubkey);
  if (!user || BigInt(user.balance) <= 0n) throw httpError(409, 'User balance is empty', 'nothing-to-withdraw');
  const out = await broadcastOrRelay([await ix.withdrawUserBalance({ signer: s.pubkey, userAcct: user })], res, 'earnings:user-balance', { amount: user.balance, amountTdvpn: tdvpn(user.balance) });
  if (out.relayed) return;
  cacheInvalidate(`balance:${s.address}`);
  res.json({ ...out.result, amount: user.balance, amountTdvpn: tdvpn(user.balance) });
}));

export default r;
