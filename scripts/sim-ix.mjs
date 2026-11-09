#!/usr/bin/env node
// ─── sim-ix: simulate instruction builders against the live program ──────────
// Spends nothing. Builds instructions with lib/solana/program.js, signs as the
// TEST_KEYFILE wallet, and runs simulateTransaction. A layout/encoding mismatch
// shows up as Anchor 101/102/2xxx/3xxx; a business-rule error (60xx) means the
// encoding was accepted. Run: node scripts/sim-ix.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Keypair, Transaction } from '@solana/web3.js';
import { ix, pda } from '../lib/solana/program.js';
import { rpcCall } from '../lib/solana/rpc.js';
import { providersByOwner, planByPda, providerUnbondingByPda } from '../lib/solana/accounts.js';
import { extractErrorCode, describeProgramError } from '../lib/solana/errors.js';

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.TEST_KEYFILE, 'utf8'))));
const me = kp.publicKey;

async function sim(name, buildIxs) {
  try {
    const ixs = await buildIxs();
    const tx = new Transaction().add(...ixs);
    tx.feePayer = me;
    tx.recentBlockhash = (await rpcCall((c) => c.getLatestBlockhash('confirmed'), { label: 'bh' })).blockhash;
    tx.sign(kp);
    const r = await rpcCall((c) => c.simulateTransaction(tx), { label: `sim:${name}` });
    const code = r.value.err ? extractErrorCode({ err: r.value.err, logs: r.value.logs }) : null;
    const verdict = !r.value.err ? 'OK' : (code >= 6000 && code < 7000 ? `rule ${code} ${describeProgramError(code).name}` : `ENCODING? ${code ?? JSON.stringify(r.value.err)}`);
    console.log(`${name.padEnd(28)} ${verdict}`);
    if (verdict.startsWith('ENCODING')) console.log('   ' + (r.value.logs || []).slice(-4).join('\n   '));
  } catch (e) {
    console.log(`${name.padEnd(28)} BUILD FAIL ${e.message}`);
  }
}

const [prov] = await providersByOwner(me.toBase58());
if (!prov) throw new Error('test wallet has no provider');
const provider = prov.address;
const plan = await planByPda('38fjwHU3gGdfHAYeUnjX6LD9zXka82Kut2ooJwudYqLG');
const planId = randomBytes(32);

await sim('open_plan', () => Promise.all([ix.openPlan({ signer: me, provider, planId, price: 1000, durationSeconds: 3600, dataCapGb: 1, maxConnections: 1 })]));
await sim('update_provider', () => Promise.all([ix.updateProvider({ signer: me, provider, uri: prov.uri })]));
await sim('delist+list_provider', async () => [await ix.delistProvider({ signer: me, provider }), await ix.listProvider({ signer: me, provider })]);
await sim('update_plan', () => Promise.all([ix.updatePlan({ signer: me, provider, plan: plan.address, price: plan.price })]));
await sim('delist+list_plan', async () => [await ix.delistPlan({ signer: me, provider, plan: plan.address }), await ix.listPlan({ signer: me, provider, plan: plan.address })]);
await sim('close_plan (listed → rule)', () => Promise.all([ix.closePlan({ signer: me, provider, plan: plan.address, rentRecipient: plan.rentRecipient })]));
await sim('open_subscription (priced)', () => Promise.all([ix.openSubscription({ signer: me, plan: plan.address, provider, planAcct: plan })]));
await sim('withdraw_provider_revenue', () => Promise.all([ix.withdrawProviderRevenue({ signer: me, provider, owner: me, amount: 1 })]));
await sim('withdraw_provider_balance', () => Promise.all([ix.withdrawProviderBalance({ signer: me, provider, owner: me })]));
await sim('sweep_provider_fees', () => Promise.all([ix.sweepProviderFees({ signer: me, providers: [provider] })]));
await sim('close_provider (→ rule)', () => Promise.all([ix.closeProvider({ signer: me, provider, providerAcct: { ...prov, providerId: Buffer.from(prov.providerId, 'hex') } })]));
const ubAddr = pda.providerUnbonding(me, Buffer.from(prov.providerId, 'hex'));
const ub = await providerUnbondingByPda(ubAddr);
console.log(`provider unbonding ${ubAddr.toBase58().slice(0, 8)}… ${ub ? 'exists' : 'none (withdraw_provider_bond not simulated)'}`);
if (ub) await sim('withdraw_provider_bond', () => Promise.all([ix.withdrawProviderBond({ signer: me, unbonding: { ...ub, providerId: Buffer.from(ub.providerId, 'hex') } })]));
