// ─── Anchor program + PDA helpers + instruction builders ─────────────────────
// Thin layer over @coral-xyz/anchor's Program. Every PDA that depends on an
// on-chain account (provider.owner, node.owner, ...) is passed EXPLICITLY so
// building an instruction never triggers a hidden RPC fetch; Anchor fills only
// the constant-seed `config` PDA and the fixed-address programs.
//
// Account lists per instruction come straight from the IDL (see
// scripts/dev notes in memory/handoff-plans-solana.md). Layout = upstream cb33092e.
// `grant` is always null here: the console signs as the owner. Delegated-key
// sessions are a later feature and would pass the grant PDA instead.
//
// Rent: every open takes a `*_rent_recipient` argument and every close names
// `rent_recipient`. The program requires it to be the signer or the rent payer
// (rent.rs); the console always pays its own rent, so it is the rent payer.
import anchorPkg from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { loadIdl, PROGRAM_ID, MINT } from './idl.js';
import { sendConnection, rpcCall } from './rpc.js';

const { Program, AnchorProvider, BN } = anchorPkg;
export { BN };

const READ_ONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: async (t) => t,
  signAllTransactions: async (t) => t,
};

let _program = null;
/** Program bound to the current preferred RPC connection; only used to build ixs and decode. */
export function getProgram() {
  if (_program) return _program;
  const provider = new AnchorProvider(sendConnection(), READ_ONLY_WALLET, { commitment: 'confirmed' });
  _program = new Program(loadIdl(), provider);
  return _program;
}

export function coder() {
  return getProgram().coder.accounts;
}

// ─── PDAs ────────────────────────────────────────────────────────────────────
const enc = (s) => Buffer.from(s, 'utf8');
const key = (k) => (k instanceof PublicKey ? k : new PublicKey(k));
const id32 = (b) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (buf.length !== 32) throw new Error(`id must be 32 bytes, got ${buf.length}`);
  return buf;
};

function find(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

export const pda = {
  config: () => find([enc('config')]),
  provider: (owner, providerId) => find([enc('provider'), key(owner).toBuffer(), id32(providerId)]),
  providerUnbonding: (owner, providerId) => find([enc('provider_unbonding'), key(owner).toBuffer(), id32(providerId)]),
  plan: (provider, planId) => find([enc('plan'), key(provider).toBuffer(), id32(planId)]),
  subscription: (owner, plan) => find([enc('subscription'), key(owner).toBuffer(), key(plan).toBuffer()]),
  lease: (provider, leaseId) => find([enc('lease'), key(provider).toBuffer(), id32(leaseId)]),
  node: (owner, nodeId) => find([enc('node'), key(owner).toBuffer(), id32(nodeId)]),
  user: (owner) => find([enc('user'), key(owner).toBuffer()]),
  grant: (granter, grantee, target) => find([enc('grant'), key(granter).toBuffer(), key(grantee).toBuffer(), key(target).toBuffer()]),
};

/** Token-2022 associated token account for `owner` on the dVPN mint. */
export function ata(owner) {
  return getAssociatedTokenAddressSync(MINT, key(owner), true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

// ─── Config (vault/treasury/params) — cached, it only changes by governance ──
let _config = null;
let _configAt = 0;
export async function fetchConfig({ maxAgeMs = 10 * 60_000 } = {}) {
  if (_config && Date.now() - _configAt < maxAgeMs) return _config;
  const addr = pda.config();
  const info = await rpcCall((c) => c.getAccountInfo(addr, 'confirmed'), { label: 'config' });
  if (!info) throw new Error(`Config account ${addr.toBase58()} not found on ${PROGRAM_ID.toBase58()}`);
  _config = coder().decode('config', info.data);
  _config.address = addr;
  _configAt = Date.now();
  return _config;
}

// ─── Instruction builders ────────────────────────────────────────────────────
// All amounts are base units (BN | string | number). Ids are 32-byte Buffers.
const bn = (v) => (BN.isBN(v) ? v : new BN(String(v)));
const opt = (v) => (v === undefined ? null : v);
const bytes = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8'));

async function tokenAccounts() {
  const cfg = await fetchConfig();
  return { vault: cfg.vault, mint: MINT, tokenProgram: TOKEN_2022_PROGRAM_ID };
}

export const ix = {
  // ── provider ──
  async openProvider({ signer, providerId, uri, bond, rentPayer = signer }) {
    const t = await tokenAccounts();
    return getProgram().methods.openProvider(Array.from(id32(providerId)), bytes(uri), bn(bond), key(rentPayer)).accounts({
      signer: key(signer),
      rentPayer: key(rentPayer),
      owner: key(signer),
      grant: null,
      provider: pda.provider(signer, providerId),
      providerUnbonding: pda.providerUnbonding(signer, providerId),
      ownerToken: ata(signer),
      vault: t.vault,
      mint: t.mint,
      systemProgram: SystemProgram.programId,
    }).instruction();
  },
  async updateProvider({ signer, provider, uri }) {
    return getProgram().methods.updateProvider(uri === undefined ? null : bytes(uri)).accounts({
      signer: key(signer), provider: key(provider), grant: null,
    }).instruction();
  },
  async listProvider({ signer, provider }) {
    return getProgram().methods.listProvider().accounts({ signer: key(signer), provider: key(provider), grant: null }).instruction();
  },
  async delistProvider({ signer, provider }) {
    return getProgram().methods.delistProvider().accounts({ signer: key(signer), provider: key(provider), grant: null }).instruction();
  },
  /** `providerAcct` = decoded Provider (needs owner, providerId, rentRecipient). */
  async closeProvider({ signer, provider, providerAcct, rentPayer = signer }) {
    const t = await tokenAccounts();
    return getProgram().methods.closeProvider(key(rentPayer)).accounts({
      signer: key(signer),
      rentPayer: key(rentPayer),
      provider: key(provider),
      owner: key(providerAcct.owner),
      grant: null,
      rentRecipient: key(providerAcct.rentRecipient),
      providerUnbonding: pda.providerUnbonding(providerAcct.owner, Buffer.from(providerAcct.providerId)),
      ownerToken: ata(providerAcct.owner),
      vault: t.vault,
      mint: t.mint,
      systemProgram: SystemProgram.programId,
    }).instruction();
  },
  /** `unbonding` = decoded ProviderUnbonding (owner, providerId, rentRecipient). */
  async withdrawProviderBond({ signer, unbonding }) {
    const t = await tokenAccounts();
    return getProgram().methods.withdrawProviderBond().accounts({
      signer: key(signer),
      providerUnbonding: pda.providerUnbonding(unbonding.owner, Buffer.from(unbonding.providerId)),
      owner: key(unbonding.owner),
      grant: null,
      rentRecipient: key(unbonding.rentRecipient),
      ownerToken: ata(unbonding.owner),
      vault: t.vault,
      mint: t.mint,
    }).instruction();
  },
  async withdrawProviderRevenue({ signer, provider, owner, amount }) {
    const t = await tokenAccounts();
    return getProgram().methods.withdrawProviderRevenue(bn(amount)).accounts({
      signer: key(signer), provider: key(provider), owner: key(owner), grant: null, ownerToken: ata(owner), vault: t.vault, mint: t.mint,
    }).instruction();
  },
  async withdrawProviderBalance({ signer, provider, owner }) {
    const t = await tokenAccounts();
    return getProgram().methods.withdrawProviderBalance().accounts({
      signer: key(signer), provider: key(provider), owner: key(owner), grant: null, ownerToken: ata(owner), vault: t.vault, mint: t.mint,
    }).instruction();
  },
  /** Providers go in `remaining_accounts`, sorted by pubkey bytes (list.rs). */
  async sweepProviderFees({ signer, providers }) {
    const cfg = await fetchConfig();
    const list = (Array.isArray(providers) ? providers : [providers]).map(key);
    list.sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
    return getProgram().methods.sweepProviderFees().accounts({
      signer: key(signer), vault: cfg.vault, treasury: cfg.treasury, mint: MINT,
    }).remainingAccounts(list.map((p) => ({ pubkey: p, isSigner: false, isWritable: true }))).instruction();
  },

  // ── plan ──
  async openPlan({ signer, provider, planId, price, durationSeconds, dataCapGb, maxConnections, rentPayer = signer }) {
    return getProgram().methods.openPlan(Array.from(id32(planId)), bn(price), Number(durationSeconds), Number(dataCapGb), Number(maxConnections), key(rentPayer)).accounts({
      signer: key(signer),
      rentPayer: key(rentPayer),
      provider: key(provider),
      grant: null,
      plan: pda.plan(provider, planId),
      systemProgram: SystemProgram.programId,
    }).instruction();
  },
  async updatePlan({ signer, provider, plan, price, durationSeconds, dataCapGb, maxConnections }) {
    return getProgram().methods.updatePlan(
      price === undefined ? null : bn(price),
      durationSeconds === undefined ? null : Number(durationSeconds),
      dataCapGb === undefined ? null : Number(dataCapGb),
      maxConnections === undefined ? null : Number(maxConnections),
    ).accounts({ signer: key(signer), provider: key(provider), grant: null, plan: key(plan) }).instruction();
  },
  async listPlan({ signer, provider, plan }) {
    return getProgram().methods.listPlan().accounts({ signer: key(signer), provider: key(provider), grant: null, plan: key(plan) }).instruction();
  },
  async delistPlan({ signer, provider, plan }) {
    return getProgram().methods.delistPlan().accounts({ signer: key(signer), provider: key(provider), grant: null, plan: key(plan) }).instruction();
  },
  async closePlan({ signer, provider, plan, rentRecipient }) {
    return getProgram().methods.closePlan().accounts({
      signer: key(signer), provider: key(provider), grant: null, plan: key(plan), rentRecipient: key(rentRecipient),
    }).instruction();
  },

  // ── subscription / user ──
  /** Priced plan: owner === signer and the signer's ATA pays. Free plan: owner may differ, token accounts omitted. */
  async openSubscription({ signer, owner = signer, plan, provider, planAcct, rentPayer = signer }) {
    const priced = bn(planAcct.price).gtn(0);
    const t = priced ? await tokenAccounts() : null;
    return getProgram().methods.openSubscription(bn(planAcct.price), Number(planAcct.durationSeconds), Number(planAcct.dataCapGb), Number(planAcct.maxConnections), key(rentPayer)).accounts({
      signer: key(signer),
      rentPayer: key(rentPayer),
      owner: key(owner),
      plan: key(plan),
      provider: key(provider),
      subscription: pda.subscription(owner, plan),
      grant: null,
      ownerToken: priced ? ata(owner) : null,
      vault: priced ? t.vault : null,
      mint: priced ? t.mint : null,
      tokenProgram: priced ? t.tokenProgram : null,
      systemProgram: SystemProgram.programId,
    }).instruction();
  },
  /** `subAcct` = decoded Subscription. `asProvider` passes the provider account (free-sub close by the provider). */
  async closeSubscription({ signer, subscription, subAcct, asProvider = false }) {
    return getProgram().methods.closeSubscription().accounts({
      signer: key(signer),
      subscription: key(subscription),
      rentRecipient: key(subAcct.rentRecipient),
      provider: asProvider ? key(subAcct.provider) : null,
      grant: null,
    }).instruction();
  },
  /** `userAcct` = decoded User (owner, rentRecipient). */
  async withdrawUserBalance({ signer, userAcct }) {
    const t = await tokenAccounts();
    return getProgram().methods.withdrawUserBalance().accounts({
      signer: key(signer), owner: key(signer), grant: null, user: pda.user(signer), rentRecipient: key(userAcct.rentRecipient), ownerToken: ata(signer), vault: t.vault, mint: t.mint,
    }).instruction();
  },

  // ── lease (manual cleanup only; the provider daemon owns roster leases) ──
  async startCloseLease({ signer, provider, lease }) {
    return getProgram().methods.startCloseLease().accounts({
      signer: key(signer), provider: key(provider), lease: key(lease), grant: null,
    }).instruction();
  },
  /** `leaseAcct` = decoded Lease (node, rentRecipient). */
  async closeLease({ signer, provider, lease, leaseAcct }) {
    return getProgram().methods.closeLease().accounts({
      signer: key(signer), provider: key(provider), lease: key(lease), grant: null, node: key(leaseAcct.node), rentRecipient: key(leaseAcct.rentRecipient),
    }).instruction();
  },
};

export { PROGRAM_ID, MINT };
