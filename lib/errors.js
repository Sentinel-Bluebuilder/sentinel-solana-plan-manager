// ─── Error handling ──────────────────────────────────────────────────────────
// Turns what the chain / RPC / daemon hand back into (a) a short message an
// operator can act on and (b) the right HTTP status. Rule carried over from
// the first console: CLASSIFY ON THE RAW ERROR, never on the rewritten text.
import { ProgramError, describeProgramError, extractErrorCode } from './solana/errors.js';
import { tdvpn } from './solana/accounts.js';

// Program-error names → operator wording. Copy rules (sentinel-solana docs/43): say what
// happened and what to do, no program error names or numbers in the text (they stay in
// the structured `programError` field), sentence form. Every cb33 code 6000–6050 has an
// entry; the unit suite fails if one goes missing.
const FRIENDLY = {
  Unauthorized: 'This wallet is not authorised for that action (owner or grant required)',
  OperationPaused: 'The program has paused this kind of operation',
  BondBelowMinimum: 'Bond is below the program minimum',
  BondPending: 'A previous bond for this id is still unbonding — withdraw it first',
  UnbondingNotElapsed: 'The unbonding window has not elapsed yet',
  UriTooLong: 'URI is too long (max 128 bytes)',
  NodeNotListed: 'Node is not listed',
  NodeNotLive: 'Node listing has expired — it must heartbeat again',
  NodePriceChanged: 'Node changed its price — refresh and retry',
  InsufficientRevenue: 'Not enough revenue to withdraw that amount',
  FeesZero: 'No protocol fees to sweep',
  ProviderNotListed: 'Provider is not listed — list it first',
  OpenPlansRemain: 'Close every plan before closing the provider',
  OpenLeasesRemain: 'Close every lease before closing the provider',
  BalanceZero: 'Nothing to withdraw',
  AmountExceedsAllowance: 'Amount exceeds the grant allowance',
  GrantExpired: 'The grant for this key has expired',
  PermissionNotGranted: 'This key has no grant for that action',
  GrantTargetMismatch: 'The grant does not cover this account',
  MissingRentRecipient: 'No rent recipient was given for the new account',
  InvalidRentRecipient: 'Rent can only go back to the signer or the rent payer',
  PlanNotListed: 'Plan is not listed — list it first',
  PlanNotDelisted: 'Delist the plan before closing it',
  PlanTermsChanged: 'Plan terms changed since the page loaded — refresh and retry',
  SubscriptionNotExpired: 'Subscription has not expired yet',
  SubscriptionPriceNotZero: 'Only free subscriptions can be closed by the provider',
  LeaseNotOpen: 'Lease is not open',
  LeaseNotClosing: 'Lease is not in its closing window',
  GraceNotElapsed: 'The close grace window has not elapsed yet',
  ModeNotVoucher: 'That action only applies to voucher-mode positions',
  ModeNotStream: 'That action only applies to stream-mode positions',
  AccountNotInitialized: 'That account does not exist on chain',
  ConstraintSeeds: 'Account derivation mismatch — wrong owner, provider or id',
  ConstraintAddress: 'An account did not match what the program expects',
  ConstraintTokenOwner: 'Token account is not owned by the signer',
  // Network settings: only the program authority can hit these.
  FeeBpsOutOfRange: 'That fee is outside the range the program allows',
  ParamOutOfRange: 'One of the values is outside the range the program allows — check the terms and retry',
  MissingPendingAuthority: 'There is no pending authority change to accept',
  InvalidMint: 'That token is not the network dVPN token',
  MintExtensionForbidden: 'That token uses a feature the program does not accept',
  MintNotSealed: 'The dVPN token is not sealed yet — this is a network setup step',
  VaultNotAssociated: 'The program vault is not the token associated account',
  VaultNotImmutable: 'The program vault can still be changed — this is a network setup step',
  InvalidTreasury: 'That treasury account is not valid for this network',
  VaultFrozen: 'The program vault is frozen, so no tokens can move right now',
  ArithmeticOverflow: 'That amount is too large for the program to handle — use a smaller amount',
  // Channels / vouchers / batches: client and node paths, listed for completeness.
  ChannelNotOpen: 'That channel is not open',
  ChannelNotClosing: 'That channel is not in its closing window',
  VoucherExceedsEscrow: 'The voucher asks for more than the deposit holds',
  RedeemableZero: 'There is nothing to redeem yet',
  InvalidVoucherSignature: 'The voucher signature does not check out',
  InvalidVoucherSigner: 'The voucher was signed by a key this position does not accept',
  BatchLengthMismatch: 'The batch lists do not line up — retry',
  BatchNotSorted: 'The batch is not in the order the program expects — retry',
  NodeReopened: 'That node was closed and reopened since the page loaded — refresh and retry',
};

/** Copy rule 9: capital first letter, ends with a full stop (or ? / …). */
export function sentence(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'Something went wrong — retry, and check the server log if it keeps happening.';
  const s = t[0].toUpperCase() + t.slice(1);
  return /[.?!…]$/.test(s) ? s : `${s}.`;
}

/** Human-readable error (≤ 180 chars, sentence form) from anything a route can catch. */
export function parseChainError(raw) {
  return sentence(rawChainError(raw));
}

function rawChainError(raw) {
  const REFUSED = 'The program refused this transaction, so nothing changed on chain — refresh and retry';
  let s = String((raw && typeof raw === 'object' && raw.message) ? raw.message : (raw || ''));
  let code = null;
  if (raw instanceof ProgramError) {
    const name = raw.programError?.name;
    if (name && FRIENDLY[name]) return FRIENDLY[name];
    code = raw.code;
    // System / token program failures carry their reason in the logs ("insufficient lamports").
    if (Array.isArray(raw.logs)) s = `${s}\n${raw.logs.join('\n')}`;
  } else {
    code = extractErrorCode(s);
    const d = code !== null ? describeProgramError(code) : null;
    if (d && FRIENDLY[d.name]) return FRIENDLY[d.name];
  }
  if (/insufficient lamports|insufficient SOL|found no record of a prior credit|InsufficientFundsForRent/i.test(s)) return 'Not enough SOL for the fee and rent — add SOL to this wallet and retry';
  if (/insufficient funds|insufficient tDVPN/i.test(s)) return 'Not enough tDVPN in this wallet for that — add tDVPN and retry';
  if (/Blockhash not found|block height exceeded|blockhash.*expired|TransactionExpired/i.test(s)) return 'Transaction expired before confirmation — retry';
  if (/Invalid public key|Non-base58|base58/i.test(s)) return 'That is not a Solana address — check it and retry';
  if (/Wallet not loaded/i.test(s)) return 'No wallet is signed in — import or connect one first';
  if (/timed out|timeout/i.test(s)) return 'The request took too long — retry in a moment';
  if (/429|Too Many Requests|rate limit/i.test(s)) return 'The Solana RPC is busy — retry in a moment';
  if (/all RPC endpoints failed|fetch failed|ECONNREFUSED|ECONNRESET/i.test(s)) return 'No Solana RPC endpoint answered — check the network and retry';
  if (/daemon .*UNAVAILABLE|No connection established|provider-daemon-unavailable/i.test(s)) return 'The provider daemon is not reachable — start it and retry';
  // Any other program code: plain sentence, the code stays in errorBody's programError field.
  if (code !== null && code !== undefined) return REFUSED;
  return s.split('\n')[0].slice(0, 160);
}

// Client (4xx) vs infrastructure (5xx). A message that carries BOTH a client
// signature and a transport signature stays 5xx (the transport failure is the
// thing that happened).
const CLIENT_ERROR_RE = /Error Number:|custom program error|"Custom"|AccountNotInitialized|Constraint|insufficient|Invalid public key|Non-base58|base58|not authori[sz]ed|not listed|not open|not found on chain|PlanTermsChanged|already|required|must be|invalid /i;
const TRANSPORT_RE = /all RPC endpoints failed|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|429|Too Many Requests|502|503|504|UNAVAILABLE|No connection established/i;

export function chainErrorStatus(err) {
  if (err && typeof err === 'object') {
    if (Number.isInteger(err.status) && err.status >= 400 && err.status < 600) return err.status;
    if (err instanceof ProgramError) return 400;
  }
  const raw = String((err && typeof err === 'object') ? (err.rawError || err.message) : (err || ''));
  if (TRANSPORT_RE.test(raw)) return 500;
  if (CLIENT_ERROR_RE.test(raw)) return 400;
  return 500;
}

/** One place that shapes an error into the API's JSON error body. */
export function errorBody(err, extra = {}) {
  const out = { ok: false, error: parseChainError(err), ...extra };
  if (err && typeof err === 'object') {
    if (err.errorCode) out.errorCode = err.errorCode;
    if (err instanceof ProgramError && err.code !== null) {
      out.programError = { code: err.code, name: err.programError?.name || null };
      if (Array.isArray(err.logs)) out.logs = err.logs.slice(-6);
    }
  }
  return out;
}

/** Express helper: `return sendError(res, err)` from any catch block. */
export function sendError(res, err, extra = {}) {
  const status = chainErrorStatus(err);
  if (status >= 500) console.error('[route]', err?.stack || err?.message || err);
  return res.status(status).json(errorBody(err, extra));
}

export { ProgramError, tdvpn, FRIENDLY };
