// ─── Params, health, fee-grant WIP stubs, client log ─────────────────────────
import { Router } from 'express';
import { route, rateLimit } from '../lib/http.js';
import { getConfig, tdvpn } from '../lib/solana/accounts.js';
import { getRpcState } from '../lib/solana/rpc.js';
import { NETWORK, PROGRAM_ID, MINT, EXPLORER_CLUSTER, TOKEN_DECIMALS } from '../lib/solana/idl.js';
import { daemonsHealth } from '../lib/daemon.js';
import { currentSession } from '../lib/session.js';
import { cached, cacheStats } from '../lib/cache.js';
import { COINGECKO } from '../lib/constants.js';

const r = Router();

r.get('/api/params', route(async (req, res) => {
  const c = await getConfig();
  res.json({
    network: NETWORK, programId: PROGRAM_ID.toBase58(), mint: MINT.toBase58(), decimals: TOKEN_DECIMALS, explorerCluster: EXPLORER_CLUSTER,
    config: {
      authority: c.authority, treasury: c.treasury, vault: c.vault, feeBps: c.feeBps, feePercent: c.feeBps / 100,
      minNodeBond: c.minNodeBond, minNodeBondTdvpn: tdvpn(c.minNodeBond), minProviderBond: c.minProviderBond, minProviderBondTdvpn: tdvpn(c.minProviderBond),
      unbondingSeconds: c.unbondingSeconds, channelCloseGraceSeconds: c.channelCloseGraceSeconds, leaseCloseGraceSeconds: c.leaseCloseGraceSeconds,
      nodeListingTtlSeconds: c.nodeListingTtlSeconds, pausedMask: c.pausedMask, feesAccrued: c.feesAccrued,
    },
  });
}));

r.get('/api/price', route(async (req, res) => {
  if (NETWORK !== 'mainnet') return res.json({ usd: null, note: 'devnet tDVPN has no market price' });
  const p = await cached('price:dvpn', 120_000, async () => {
    const resp = await fetch(`${COINGECKO}/simple/price?ids=sentinel&vs_currencies=usd`);
    const j = await resp.json();
    return j?.sentinel?.usd ?? null;
  });
  res.json({ usd: p });
}));

r.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), network: NETWORK }));
r.get('/health/rpc', route(async (req, res) => {
  const state = await getRpcState();
  res.status(state.slot ? 200 : 503).json({ status: state.slot ? 'ok' : 'down', ...state, cache: cacheStats(), checkedAt: new Date().toISOString() });
}));
// Without a session only liveness is shown: the gRPC target and error text name internal hosts.
export const daemonView = (d) => (currentSession() ? d : { providerPda: d.providerPda, ok: d.ok });
r.get('/health/daemons', route(async (req, res) => res.json({ daemons: (await daemonsHealth()).map(daemonView) })));

// ─── Fee grants: kept in the UI as work-in-progress; no live function on Solana ──
const WIP = { ok: false, wip: true, errorCode: 'not-on-solana-yet', error: 'Fee grants are not available on Solana yet (no standing allowance object on chain). This page is a work in progress.' };
r.get('/api/feegrant/grants', (req, res) => res.json({ grants: [], wip: true, note: WIP.error }));
r.get('/api/feegrant/gas-costs', (req, res) => res.json({ wip: true, note: WIP.error }));
r.get('/api/feegrant/auto-grant', (req, res) => res.json({ enabled: false, wip: true, note: WIP.error }));
r.get('/api/feegrant/grant-subscribers-stream', (req, res) => res.status(501).json(WIP));
for (const p of ['grant', 'grant-subscribers', 'revoke', 'revoke-list', 'revoke-all', 'auto-grant']) {
  r.post(`/api/feegrant/${p}`, (req, res) => res.status(501).json(WIP));
}

r.post('/api/_clientlog', rateLimit('clientlog', 60, 60_000), (req, res) => {
  const { level = 'error', message = '', stack = '' } = req.body || {};
  console[level === 'warn' ? 'warn' : 'error'](`[client] ${String(message).slice(0, 300)} ${String(stack).slice(0, 300)}`);
  res.json({ ok: true });
});

export default r;
