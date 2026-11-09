// ─── Program error decoding (network-aware) ──────────────────────────────────
// Since the 2026-11-02 upgrade devnet runs upstream cb33092e, so the vendored
// IDL's error table is the chain's own (6000–6050). The pre-cb33 devnet shift
// (6022–6038 off by one) is gone. Branch on NUMBERS, translate here.
import { loadIdl } from './idl.js';

let _source = null;
function sourceTable() {
  if (_source) return _source;
  _source = new Map();
  for (const e of loadIdl().errors || []) _source.set(e.code, { code: e.code, name: e.name, message: e.msg || '' });
  return _source;
}

/** Translate a code AS THE CHAIN REPORTS IT into the matching source entry. */
export function describeProgramError(code) {
  const n = Number(code);
  const src = sourceTable();
  const hit = src.get(n);
  if (hit) return { ...hit, code: n };
  const fw = ANCHOR_FRAMEWORK[n];
  if (fw) return { code: n, name: fw[0], message: fw[1] };
  return { code: n, name: `Program error ${n}`, message: '' };
}

// Anchor framework errors that surface from constraint checks (subset we have hit).
const ANCHOR_FRAMEWORK = {
  100: ['InstructionMissing', 'instruction discriminator not provided'],
  101: ['InstructionFallbackNotFound', 'fallback not found'],
  102: ['InstructionDidNotDeserialize', 'the program could not deserialize the instruction data'],
  2000: ['ConstraintMut', 'a mut constraint was violated'],
  2001: ['ConstraintHasOne', 'a has one constraint was violated'],
  2002: ['ConstraintSigner', 'a signer constraint was violated'],
  2003: ['ConstraintRaw', 'a raw constraint was violated'],
  2006: ['ConstraintSeeds', 'a seeds constraint was violated'],
  2012: ['ConstraintAddress', 'an address constraint was violated'],
  2014: ['ConstraintTokenMint', 'a token mint constraint was violated'],
  2015: ['ConstraintTokenOwner', 'a token owner constraint was violated'],
  2019: ['ConstraintAccountIsNone', 'a required account was not provided'],
  3005: ['AccountDidNotSerialize', 'failed to serialize the account'],
  3007: ['AccountOwnedByWrongProgram', 'the given account is owned by a different program than expected'],
  3012: ['AccountNotInitialized', 'the program expected this account to be already initialized'],
};

/**
 * Pull a program error code out of anything the RPC / web3.js hands back:
 * simulation `err` objects, SendTransactionError messages, log lines.
 */
export function extractErrorCode(errOrLogs) {
  const texts = [];
  const push = (x) => { if (x !== undefined && x !== null) texts.push(typeof x === 'string' ? x : JSON.stringify(x)); };
  if (Array.isArray(errOrLogs)) errOrLogs.forEach(push);
  else if (errOrLogs && typeof errOrLogs === 'object') {
    push(errOrLogs.message);
    push(errOrLogs.err);
    push(errOrLogs.transactionError);
    if (Array.isArray(errOrLogs.logs)) errOrLogs.logs.forEach(push);
    if (Array.isArray(errOrLogs.transactionLogs)) errOrLogs.transactionLogs.forEach(push);
    push(errOrLogs);
  } else push(errOrLogs);
  const blob = texts.join('\n');
  let m = blob.match(/Error Number:\s*(\d+)/);
  if (m) return Number(m[1]);
  m = blob.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (m) return parseInt(m[1], 16);
  m = blob.match(/"Custom"\s*:\s*(\d+)/);
  if (m) return Number(m[1]);
  return null;
}

/** Non-program failure reasons the chain can report for a transaction. */
export function describeInstructionError(errObj) {
  const s = typeof errObj === 'string' ? errObj : JSON.stringify(errObj || '');
  if (/InsufficientFundsForRent/.test(s)) return 'insufficient SOL to pay rent for a new account';
  if (/InsufficientFunds/.test(s)) return 'insufficient funds';
  if (/AccountNotFound/.test(s)) return 'fee payer account has no SOL';
  if (/BlockhashNotFound/.test(s)) return 'blockhash expired — retry';
  if (/AlreadyProcessed|already been processed/i.test(s)) return 'transaction already processed';
  if (/ProgramFailedToComplete|ComputationalBudgetExceeded/.test(s)) return 'compute budget exceeded';
  return null;
}

/** Shape a failure (simulation or send) into one Error carrying the decoded program error. */
export class ProgramError extends Error {
  constructor(source, { logs } = {}) {
    const code = extractErrorCode(source);
    const desc = code !== null ? describeProgramError(code) : null;
    const logText = (logs || source?.logs || []).join('\n');
    const solInsufficient = /insufficient lamports/i.test(logText);
    const tokenInsufficient = code === 1 && !solInsufficient && /Tokenz|Token-2022|insufficient funds/i.test(logText);
    let message;
    if (desc && code >= 6000) message = `${desc.name} (${code}): ${desc.message}`;
    else if (solInsufficient) message = 'insufficient SOL balance';
    else if (tokenInsufficient) message = 'insufficient tDVPN balance';
    else if (desc && code !== null) message = `${desc.name} (${code}): ${desc.message}`;
    else message = describeInstructionError(source?.err || source) || source?.message || String(source);
    super(message);
    this.name = 'ProgramError';
    this.code = code;
    this.programError = desc;
    this.logs = logs || source?.logs || null;
    this.rawError = typeof source === 'string' ? source : (source?.message || JSON.stringify(source?.err || source));
  }
}
