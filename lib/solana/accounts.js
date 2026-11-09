// ─── Account readers ─────────────────────────────────────────────────────────
// Chain is the database. Every reader here is `getProgramAccounts` with an
// explicit DEPLOYED dataSize + discriminator memcmp (+ caller memcmps), decoded
// by Anchor's coder under the network's IDL, then normalised to plain JSON:
// pubkeys as base58, u64 as base-unit strings, ids as hex, byte strings as utf8.
//
// Never `program.account.X.all()`: that path can inject the SOURCE size and
// return [] on devnet with HTTP 200 (docs/14 divergence 2).
import { PublicKey } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
import { rpcCall } from './rpc.js';
import { coder, pda, fetchConfig, PROGRAM_ID } from './program.js';
import { DEPLOYED_SIZES, discriminator, OFFSETS, protocolNames, TOKEN_DECIMALS } from './idl.js';

const { BN } = anchorPkg;
const bs58 = anchorPkg.utils.bytes.bs58;

export function accountSize(name) {
  return DEPLOYED_SIZES ? DEPLOYED_SIZES[name] : coder().size(name);
}

// ─── normalisers ─────────────────────────────────────────────────────────────
function norm(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof PublicKey) return v.toBase58();
  if (BN.isBN(v)) return v.toString(10);
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (Array.isArray(v)) return v.every((x) => typeof x === 'number') ? Buffer.from(v).toString('hex') : v.map(norm);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = norm(x);
    return out;
  }
  return v;
}

function utf8Field(bytesArr, len) {
  return Buffer.from(bytesArr.slice(0, len)).toString('utf8');
}

export function tdvpn(baseUnits) {
  const s = String(baseUnits ?? '0');
  const n = BigInt(s);
  const whole = n / 10n ** BigInt(TOKEN_DECIMALS);
  const frac = (n % 10n ** BigInt(TOKEN_DECIMALS)).toString().padStart(TOKEN_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function inputError(msg) {
  const e = new Error(msg);
  e.status = 400;
  e.errorCode = 'invalid-field';
  return e;
}

export function toBaseUnits(amountStr) {
  const s = String(amountStr).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw inputError(`invalid tDVPN amount "${amountStr}"`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > TOKEN_DECIMALS) throw inputError(`tDVPN has ${TOKEN_DECIMALS} decimals, got "${amountStr}"`);
  const base = BigInt(whole) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt((frac + '0'.repeat(TOKEN_DECIMALS)).slice(0, TOKEN_DECIMALS));
  if (base > U64_MAX) throw inputError(`tDVPN amount "${amountStr}" exceeds the u64 maximum`);
  return base.toString();
}

export const U64_MAX = 2n ** 64n - 1n;

/** A base-unit amount (u64): digits only, no sign, no decimals. Throws 400. */
export function baseUnitsArg(v, label = 'amount') {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) throw inputError(`${label} must be a whole number of base units, got "${v}"`);
  const n = BigInt(s);
  if (n > U64_MAX) throw inputError(`${label} exceeds the u64 maximum`);
  return n.toString();
}

/** SOL amount string → lamports (bigint). Plain decimal, at most 9 places. Throws 400. */
export function toLamports(amountStr) {
  const s = String(amountStr ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw inputError(`invalid SOL amount "${amountStr}"`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 9) throw inputError(`SOL has 9 decimals, got "${amountStr}"`);
  const n = BigInt(whole) * 1_000_000_000n + BigInt((frac + '000000000').slice(0, 9));
  if (n > U64_MAX) throw inputError(`SOL amount "${amountStr}" exceeds the u64 maximum`);
  return n;
}

function decodeTyped(name, data) {
  const raw = coder().decode(name, data);
  const out = norm(raw);
  switch (name) {
    case 'provider':
    case 'node':
      out.uri = utf8Field(raw.uri, raw.uriLen);
      delete out.uriLen;
      if (name === 'node') {
        out.country = Buffer.from(raw.country).toString('utf8');
        out.protocolNames = protocolNames(raw.protocols);
      }
      break;
    default:
      break;
  }
  delete out.reserved;
  return out;
}

export function decodeAccount(name, data) {
  return decodeTyped(name, data);
}

// ─── generic fetchers ────────────────────────────────────────────────────────
export async function fetchOne(name, address, { label } = {}) {
  const addr = new PublicKey(address);
  const info = await rpcCall((c) => c.getAccountInfo(addr, 'confirmed'), { label: label || `${name}:${addr.toBase58().slice(0, 6)}` });
  if (!info) return null;
  if (!info.owner.equals(PROGRAM_ID)) return null;
  // A program account of another type (a node pasted where a plan belongs) is a
  // caller mistake, not a server fault: 400 with a name for it.
  const wrongType = () => {
    const e = new Error(`${addr.toBase58()} is not a ${name} account`);
    e.status = 400; e.errorCode = 'wrong-account-type';
    return e;
  };
  if (info.data.length !== accountSize(name)) throw wrongType();
  if (!Buffer.from(info.data.subarray(0, 8)).equals(Buffer.from(discriminator(name)))) throw wrongType();
  return { address: addr.toBase58(), ...decodeTyped(name, info.data) };
}

export async function fetchMany(name, memcmps = [], { label } = {}) {
  const filters = [
    { dataSize: accountSize(name) },
    { memcmp: { offset: 0, bytes: bs58.encode(discriminator(name)) } },
    ...memcmps.map(({ offset, pubkey }) => ({ memcmp: { offset, bytes: new PublicKey(pubkey).toBase58() } })),
  ];
  const rows = await rpcCall(
    (c) => c.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', filters }),
    { label: label || `${name}:list`, timeoutMs: 30_000 },
  );
  return rows.map((r) => ({ address: r.pubkey.toBase58(), ...decodeTyped(name, r.account.data) }));
}

// ─── typed readers ───────────────────────────────────────────────────────────
export async function getConfig() {
  const c = await fetchConfig();
  return norm({ ...c, address: c.address });
}

export const providersByOwner = (owner) => fetchMany('provider', [{ offset: OFFSETS.provider.owner, pubkey: owner }], { label: 'providers:owner' });
export const allProviders = () => fetchMany('provider', [], { label: 'providers:all' });
export const providerByPda = (addr) => fetchOne('provider', addr);
export const providerUnbondingByPda = (addr) => fetchOne('providerUnbonding', addr);

export const plansByProvider = (provider) => fetchMany('plan', [{ offset: OFFSETS.plan.provider, pubkey: provider }], { label: 'plans:provider' });
export const allPlans = () => fetchMany('plan', [], { label: 'plans:all' });
export const planByPda = (addr) => fetchOne('plan', addr);

export const subscriptionsByPlan = (plan) => fetchMany('subscription', [{ offset: OFFSETS.subscription.plan, pubkey: plan }], { label: 'subs:plan' });
export const subscriptionsByOwner = (owner) => fetchMany('subscription', [{ offset: OFFSETS.subscription.owner, pubkey: owner }], { label: 'subs:owner' });
export const subscriptionByPda = (addr) => fetchOne('subscription', addr);
export const subscriptionByOwnerPlan = (owner, plan) => fetchOne('subscription', pda.subscription(owner, plan));

export const leasesByProvider = (provider) => fetchMany('lease', [{ offset: OFFSETS.lease.provider, pubkey: provider }], { label: 'leases:provider' });
export const leaseByPda = (addr) => fetchOne('lease', addr);

export const allNodes = () => fetchMany('node', [], { label: 'nodes:all' });
export const nodeByPda = (addr) => fetchOne('node', addr);

export const userByOwner = (owner) => fetchOne('user', pda.user(owner));

export { pda, PROGRAM_ID };
