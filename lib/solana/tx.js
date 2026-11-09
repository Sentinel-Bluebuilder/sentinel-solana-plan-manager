// ─── Transaction build / simulate / send / relay ─────────────────────────────
// ONE write path for every route:
//
//   const r = await broadcastOrRelay(ixs, res, 'open_plan');
//   if (r.relayed) return;            // wallet session: unsigned tx handed to the browser
//   res.json(r.result);               // keypair / privy session: landed on chain
//
// Session contract (lib/session.js): { kind: 'keypair'|'wallet'|'privy',
// pubkey: PublicKey, signTransaction(tx)?: Promise<VersionedTransaction>,
// broadcastQueue: Promise }. keypair and privy sessions implement
// signTransaction; wallet sessions do not (the browser signs).
//
// Every tx is simulated BEFORE anyone signs it, so a program error reaches the
// operator as a named 4xx instead of a wallet popup followed by a failure.
import {
  ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { rpcCall, isTransportError, COMMITMENT } from './rpc.js';
import { PROGRAM_ID } from './idl.js';
import { ProgramError } from './errors.js';
import { currentSession } from '../session.js';

const CU_MARGIN = 1.2; // dvpnctl: compute_unit_margin = 20 (%)
const CU_FLOOR = 20_000;
const CU_CEIL = 1_400_000;
const MAX_PRIORITY_FEE = 100_000; // µ-lamports / CU, dvpnctl's max_priority_fee
const CONFIRM_TIMEOUT_MS = 60_000;

export const ALLOWED_PROGRAMS = [
  PROGRAM_ID,
  SystemProgram.programId,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ComputeBudgetProgram.programId,
].map((k) => k.toBase58());

export class SessionRequiredError extends Error {
  constructor() { super('Wallet not loaded'); this.name = 'SessionRequiredError'; this.status = 401; }
}

/**
 * Median recent priority fee paid by txs that wrote the same accounts this one
 * writes (the program id itself is never writable, so filtering on it returns
 * nothing). At most 128 keys per the RPC method.
 */
async function priorityFee(ixs) {
  const writable = [...new Set(ixs.flatMap((i) => i.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())))]
    .slice(0, 128).map((k) => new PublicKey(k));
  try {
    const fees = await rpcCall((c) => c.getRecentPrioritizationFees({ lockedWritableAccounts: writable }), { label: 'priorityFee', attempts: 1, timeoutMs: 5000 });
    const vals = fees.map((f) => f.prioritizationFee).filter((n) => n > 0).sort((a, b) => a - b);
    if (!vals.length) return 0;
    return Math.min(MAX_PRIORITY_FEE, vals[Math.floor(vals.length / 2)]);
  } catch (err) {
    console.warn(`[tx] priority fee lookup failed, using 0: ${err.message}`);
    return 0;
  }
}

/**
 * Build an unsigned v0 transaction: simulate for CU and errors, then prepend the
 * compute-budget instructions. Throws ProgramError on a simulation failure.
 */
export async function buildTx(ixs, feePayer, { label = 'tx' } = {}) {
  if (!ixs.length) throw new Error(`${label}: no instructions`);
  const payer = new PublicKey(feePayer);
  const { blockhash, lastValidBlockHeight } = await rpcCall((c) => c.getLatestBlockhash(COMMITMENT), { label: `${label}:blockhash` });

  const probe = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const sim = await rpcCall((c) => c.simulateTransaction(probe, { sigVerify: false, replaceRecentBlockhash: true, commitment: COMMITMENT }), { label: `${label}:simulate` });
  if (sim.value.err) throw new ProgramError({ err: sim.value.err, logs: sim.value.logs }, { logs: sim.value.logs });
  const units = Math.min(CU_CEIL, Math.max(CU_FLOOR, Math.ceil((sim.value.unitsConsumed || CU_FLOOR) * CU_MARGIN)));

  const fee = await priorityFee(ixs);
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (fee > 0) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [...budget, ...ixs] }).compileToV0Message());
  return { tx, blockhash, lastValidBlockHeight, unitsConsumed: sim.value.unitsConsumed, priorityFee: fee, logs: sim.value.logs };
}

/** Send a fully signed tx and wait for `confirmed`. Returns the API tx result shape. */
export async function sendSigned(tx, { lastValidBlockHeight, label = 'tx' } = {}) {
  const raw = tx.serialize();
  const expected = bs58.encode(tx.signatures[0]);
  let signature;
  try {
    // Re-sending identical signed bytes is idempotent (same signature), so a
    // transport failure can safely retry on the next endpoint.
    signature = await rpcCall((c) => c.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: COMMITMENT, maxRetries: 3 }), { label: `${label}:send`, timeoutMs: 30_000 });
  } catch (err) {
    // A lost send response followed by a retry lands here: the tx IS on chain, so confirm it.
    if (/already been processed|AlreadyProcessed/i.test(String(err?.message || ''))) signature = expected;
    else if (isTransportError(err)) throw err;
    else throw new ProgramError(err, { logs: err.logs });
  }
  if (!lastValidBlockHeight) {
    // Relayed tx: its expiry height is not in the tx; a fresh blockhash's height
    // is a safe upper bound (≥ the real one), so confirmation never gives up early.
    const bh = await rpcCall((c) => c.getLatestBlockhash(COMMITMENT), { label: `${label}:blockhash` });
    lastValidBlockHeight = bh.lastValidBlockHeight;
  }
  return confirmSignature(signature, { lastValidBlockHeight, label });
}

/**
 * Confirmation polled through the RPC pool. web3's confirmTransaction is bound
 * to ONE connection with retries disabled, so a single 429 while polling turned
 * a landed tx into a 500. Here every poll benches and rotates like any read.
 */
async function confirmSignature(signature, { lastValidBlockHeight, label }) {
  const started = Date.now();
  while (Date.now() - started < CONFIRM_TIMEOUT_MS) {
    const st = await rpcCall((c) => c.getSignatureStatuses([signature]), { label: `${label}:status`, attempts: 2, timeoutMs: 8000 });
    const v = st.value[0];
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) {
      if (v.err) throw new ProgramError({ err: v.err, message: `transaction ${signature} failed` });
      return { ok: true, txHash: signature, slot: v.slot };
    }
    const height = await rpcCall((c) => c.getBlockHeight(COMMITMENT), { label: `${label}:height`, attempts: 2, timeoutMs: 8000 });
    if (height > lastValidBlockHeight) throw new Error(`${label}: transaction ${signature} expired (block height exceeded) before confirmation`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: confirmation timed out after ${CONFIRM_TIMEOUT_MS / 1000}s (signature ${signature})`);
}

function requireSession() {
  const s = currentSession();
  if (!s || !s.pubkey) throw new SessionRequiredError();
  return s;
}

/** Serialise an unsigned tx for a browser wallet. */
export function encodeTx(tx) {
  return Buffer.from(tx.serialize()).toString('base64');
}

export function decodeTx(b64) {
  try {
    return VersionedTransaction.deserialize(Buffer.from(String(b64), 'base64'));
  } catch (err) {
    const e = new Error(`tx is not a valid base64 VersionedTransaction: ${err.message}`);
    e.status = 400; e.errorCode = 'invalid-tx';
    throw e;
  }
}

/** Fee payer must be the session; every program id must be allow-listed. Throws on violation. */
export function assertRelayable(tx, sessionPubkey) {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  const payer = keys[0];
  if (!payer || !payer.equals(new PublicKey(sessionPubkey))) {
    const e = new Error('Signed transaction fee payer does not match the session wallet');
    e.status = 403; throw e;
  }
  for (const ci of msg.compiledInstructions) {
    const pid = keys[ci.programIdIndex];
    if (!pid || !ALLOWED_PROGRAMS.includes(pid.toBase58())) {
      const e = new Error(`Transaction calls a program this relay does not accept: ${pid ? pid.toBase58() : '?'}`);
      e.status = 403; throw e;
    }
  }
  if (msg.addressTableLookups && msg.addressTableLookups.length) {
    const e = new Error('Address lookup tables are not accepted by this relay'); e.status = 403; throw e;
  }
}

/**
 * The one write path. Builds + simulates; then either signs server-side (keypair,
 * privy) and lands the tx, or hands the unsigned tx to the browser (wallet).
 */
/**
 * `relayInfo` rides on the wallet-sign response so the browser (and tests) know
 * which account the tx creates (planId, subscriptionId, provider) before it lands.
 */
export async function broadcastOrRelay(ixs, res, label = 'tx', relayInfo = {}) {
  const session = requireSession();
  const run = async () => {
    const built = await buildTx(ixs, session.pubkey, { label });
    if (session.kind === 'wallet') {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ mode: 'wallet-sign', tx: encodeTx(built.tx), label, unitsConsumed: built.unitsConsumed, ...relayInfo });
      return { relayed: true };
    }
    if (typeof session.signTransaction !== 'function') throw new Error(`session kind ${session.kind} cannot sign`);
    const signed = await session.signTransaction(built.tx);
    const result = await sendSigned(signed, { lastValidBlockHeight: built.lastValidBlockHeight, label });
    return { relayed: false, result: { ...result, unitsConsumed: built.unitsConsumed, label } };
  };
  // Serialise sends per session so two concurrent writes never race on the same blockhash/nonce window.
  const p = session.broadcastQueue.then(run, run);
  session.broadcastQueue = p.catch(() => {});
  return p;
}

/** Relay route helper: a browser-signed tx comes back, is validated, and sent. */
export async function relaySignedTx(b64, { label = 'relay' } = {}) {
  const session = requireSession();
  const tx = decodeTx(b64);
  assertRelayable(tx, session.pubkey);
  const run = () => sendSigned(tx, { label });
  const p = session.broadcastQueue.then(run, run);
  session.broadcastQueue = p.catch(() => {});
  return p;
}
