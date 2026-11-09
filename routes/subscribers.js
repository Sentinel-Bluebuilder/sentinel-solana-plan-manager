// ─── Subscribers ─────────────────────────────────────────────────────────────
// Priced plans: the subscriber must open their own subscription (program pins
// owner == signer). Free plans: the provider owner can gift subscriptions to
// any address — that is the on-chain "add subscriber".
import { Router } from 'express';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { route, httpError, pubkeyArg, walletArg, rateLimit, requireSession, assertPlanOwnership } from '../lib/http.js';
import { parseChainError } from '../lib/errors.js';
import { ix, pda, ata, fetchConfig } from '../lib/solana/program.js';
import { planByPda, providerByPda, subscriptionByPda, subscriptionByOwnerPlan, nodeByPda, tdvpn } from '../lib/solana/accounts.js';
import { MINT } from '../lib/solana/idl.js';
import { broadcastOrRelay } from '../lib/solana/tx.js';
import { cacheInvalidate } from '../lib/cache.js';
import { requestTicket, metadata } from '../lib/nodeapi.js';
import { providerApiOverrides } from '../lib/daemon.js';
import { MAX_BATCH_ADDRESSES, SUBSCRIPTIONS_PER_TX } from '../lib/constants.js';
import { shapeSubscription, shapePlan } from './plans.js';

const r = Router();

/** What a would-be subscriber needs to subscribe to a priced plan themselves. */
export async function sharePayload(plan, forAddress = '<your wallet>') {
  const cfg = await fetchConfig();
  const owner = forAddress;
  const subscriberToken = forAddress.startsWith('<') ? '<your tDVPN token account>' : ata(new PublicKey(forAddress)).toBase58();
  const command = [
    'dvpnctl subscription open-subscription',
    `--plan ${plan.address} --provider ${plan.provider} --owner ${owner}`,
    `--expected-price ${plan.price} --expected-duration-seconds ${plan.durationSeconds}`,
    `--expected-data-cap-gb ${plan.dataCapGb} --expected-max-connections ${plan.maxConnections}`,
    `--mint ${MINT.toBase58()} --vault ${cfg.vault.toBase58()} --subscriber-token ${subscriberToken}`,
    `--token-program ${TOKEN_2022_PROGRAM_ID.toBase58()} --rent-payer ${owner}`,
  ].join(' \\\n  ');
  return { plan: plan.address, provider: plan.provider, price: plan.price, priceTdvpn: tdvpn(plan.price), command };
}

r.post('/api/plan/subscribe', route(async (req, res) => {
  const s = requireSession();
  const plan = await planByPda(pubkeyArg(req.body?.planId, 'planId'));
  if (!plan) throw httpError(404, 'Plan not found on chain', 'plan-not-found');
  if (plan.status !== 1) throw httpError(409, 'Plan is not listed', 'plan-not-listed');
  const existing = await subscriptionByOwnerPlan(s.pubkey, plan.address);
  if (existing) return res.status(409).json({ ok: false, error: 'This wallet already holds a subscription to that plan', errorCode: 'already-subscribed', subscription: shapeSubscription(existing) });
  const built = await ix.openSubscription({ signer: s.pubkey, owner: s.pubkey, plan: plan.address, provider: plan.provider, planAcct: plan });
  const out = await broadcastOrRelay([built], res, 'subscription:open', { subscriptionId: pda.subscription(s.pubkey, plan.address).toBase58(), planId: plan.address });
  if (out.relayed) return;
  cacheInvalidate(`subs:${plan.address}`);
  cacheInvalidate(`balance:${s.address}`);
  res.json({ ...out.result, subscriptionId: pda.subscription(s.pubkey, plan.address).toBase58(), planId: plan.address, price: plan.price, priceTdvpn: tdvpn(plan.price) });
}));

async function giftSubscriptions(req, res, plan, addresses, { invalid = [] } = {}) {
  const s = requireSession();
  if (BigInt(plan.price) > 0n) {
    return res.status(400).json({
      ok: false, errorCode: 'subscriber-must-self-subscribe',
      error: 'Priced plans can only be bought by the subscriber themself (the program pins owner to the signer). Share the plan instead.',
      share: await sharePayload(plan, addresses.length === 1 ? addresses[0] : undefined),
      needSubscription: addresses,
    });
  }
  if (plan.status !== 1) throw httpError(409, 'Plan is not listed — list it before adding subscribers', 'plan-not-listed');
  const results = [];
  const todo = [];
  for (const addr of addresses) {
    const existing = await subscriptionByOwnerPlan(addr, plan.address);
    if (existing) results.push({ address: addr, ok: true, already: true, subscriptionId: existing.address });
    else todo.push(addr);
  }
  if (s.kind === 'wallet' && todo.length > SUBSCRIPTIONS_PER_TX) {
    throw httpError(400, `A browser wallet signs one transaction per request; add at most ${SUBSCRIPTIONS_PER_TX} new subscribers at a time`, 'batch-too-large');
  }
  for (let i = 0; i < todo.length; i += SUBSCRIPTIONS_PER_TX) {
    const chunk = todo.slice(i, i + SUBSCRIPTIONS_PER_TX);
    const ixs = [];
    for (const addr of chunk) ixs.push(await ix.openSubscription({ signer: s.pubkey, owner: addr, plan: plan.address, provider: plan.provider, planAcct: plan }));
    try {
      const out = await broadcastOrRelay(ixs, res, 'subscription:gift', { planId: plan.address, subscriptionIds: chunk.map((a) => pda.subscription(a, plan.address).toBase58()), invalid });
      if (out.relayed) return true;
      for (const addr of chunk) results.push({ address: addr, ok: true, subscriptionId: pda.subscription(addr, plan.address).toBase58(), txHash: out.result.txHash });
    } catch (err) {
      for (const addr of chunk) results.push({ address: addr, ok: false, error: parseChainError(err) });
    }
    if (i + SUBSCRIPTIONS_PER_TX < todo.length) await new Promise((ok) => setTimeout(ok, 7000));
  }
  cacheInvalidate(`subs:${plan.address}`);
  const added = results.filter((x) => x.ok && !x.already).length;
  const failed = results.filter((x) => !x.ok).length;
  const status = failed && !added && !results.some((x) => x.already) ? 400 : 200;
  // `invalid` = inputs rejected before any tx (bad base58 or not a wallet); reported so nothing is dropped silently.
  res.status(status).json({ ok: failed === 0, planId: plan.address, added, failed, results, invalid });
  return false;
}

r.post('/api/plan/add-subscriber', route(async (req, res) => {
  const plan = await assertPlanOwnership(req.body?.planId);
  const addr = walletArg(req.body?.address ?? req.body?.member, 'address').toBase58();
  await giftSubscriptions(req, res, plan, [addr]);
}));

r.post('/api/plan/add-subscribers', route(async (req, res) => {
  const plan = await assertPlanOwnership(req.body?.planId);
  const raw = req.body?.addresses ?? req.body?.members;
  if (!Array.isArray(raw) || !raw.length) throw httpError(400, 'addresses[] required', 'missing-field');
  if (raw.length > MAX_BATCH_ADDRESSES) throw httpError(400, `At most ${MAX_BATCH_ADDRESSES} addresses per request`, 'batch-too-large');
  const valid = []; const invalid = [];
  for (const a of raw) {
    try { valid.push(walletArg(a, 'address').toBase58()); } catch (err) { invalid.push({ address: String(a), error: err.message, errorCode: err.errorCode }); }
  }
  if (!valid.length) return res.status(400).json({ ok: false, error: 'No valid Solana wallet addresses supplied', errorCode: 'invalid-address', invalid });
  await giftSubscriptions(req, res, plan, [...new Set(valid)], { invalid });
}));

r.post('/api/plan/close-subscription', route(async (req, res) => {
  const s = requireSession();
  const subAddr = pubkeyArg(req.body?.subscription ?? req.body?.subscriptionId, 'subscription');
  const sub = await subscriptionByPda(subAddr);
  if (!sub) throw httpError(404, 'Subscription not found on chain', 'subscription-not-found');
  const isOwner = sub.owner === s.address;
  let asProvider = false;
  if (!isOwner) {
    const prov = await providerByPda(sub.provider);
    const expired = Number(sub.expiresAt) <= Math.floor(Date.now() / 1000);
    if (prov && prov.owner === s.address && BigInt(sub.price) === 0n) asProvider = true;
    else if (!expired) throw httpError(403, 'Only the owner can close an unexpired paid subscription', 'not-subscription-owner');
  }
  const out = await broadcastOrRelay([await ix.closeSubscription({ signer: s.pubkey, subscription: sub.address, subAcct: sub, asProvider })], res, 'subscription:close', { subscriptionId: sub.address, planId: sub.plan });
  if (out.relayed) return;
  cacheInvalidate(`subs:${sub.plan}`);
  res.json({ ...out.result, subscriptionId: sub.address, planId: sub.plan, closed: true });
}));

/**
 * Prove a plan is serviceable: ask the provider for an access ticket for the
 * session's own subscription on one of its roster nodes. Needs the secret key
 * (the ticket request is signed off-chain), so keypair sessions only.
 */
async function requestTicketHandler(req, res) {
  const s = requireSession();
  if (s.kind !== 'keypair') throw httpError(400, 'Ticket requests are signed with the wallet\'s secret key; use a key session for this test', 'keypair-session-required');
  const plan = await planByPda(pubkeyArg(req.body?.planId, 'planId'));
  if (!plan) throw httpError(404, 'Plan not found on chain', 'plan-not-found');
  const sub = await subscriptionByOwnerPlan(s.pubkey, plan.address);
  if (!sub) throw httpError(409, 'This wallet has no subscription to that plan', 'not-subscribed');
  const node = pubkeyArg(req.body?.node ?? req.body?.nodeAddress, 'node');
  if (Number(sub.expiresAt) <= Math.floor(Date.now() / 1000)) throw httpError(409, 'Subscription has expired', 'subscription-expired');
  const nodeAcct = await nodeByPda(node);
  if (!nodeAcct) throw httpError(404, 'Node not found on chain', 'node-not-found');
  const prov = await providerByPda(plan.provider);
  if (!prov) throw httpError(404, 'Provider not found on chain', 'provider-not-found');
  const providerUri = providerApiOverrides().get(plan.provider) || prov.uri;
  const t0 = Date.now();
  // The daemon advertises its certificate hash in /v1/metadata; the ticket
  // request is pinned to it. The metadata read itself is first contact, so the
  // pin is a consistency check against the provider, not an independent root of trust.
  let pinSha256 = null;
  try { pinSha256 = (await metadata(providerUri)).json?.payload?.api?.tls_sha256 || null; } catch (err) {
    console.warn(`[ticket] metadata read for ${providerUri} failed, requesting without a pin: ${err.message}`);
  }
  const { raw, ticket } = await requestTicket(s.keypair, providerUri, { subscription: sub.address, node: node.toBase58(), provider: plan.provider }, { pinSha256 });
  res.json({ ok: true, planId: plan.address, subscriptionId: sub.address, node: node.toBase58(), providerUri, onChainUri: prov.uri, tlsPinned: !!pinSha256, latencyMs: Date.now() - t0, ticket, raw });
}
r.post('/api/plan/request-ticket', route(requestTicketHandler));

r.get('/api/plans/:id/share', rateLimit('planread', 120, 60_000), route(async (req, res) => {
  const plan = await planByPda(pubkeyArg(req.params.id, 'planId'));
  if (!plan) throw httpError(404, 'Plan not found on chain', 'plan-not-found');
  res.json({ plan: shapePlan(plan), share: await sharePayload(plan, typeof req.query.for === 'string' ? pubkeyArg(req.query.for, 'for').toBase58() : undefined) });
}));

export default r;
