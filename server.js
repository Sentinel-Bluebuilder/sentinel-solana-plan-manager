// ─── Plan Manager (Solana) — server ──────────────────────────────────────────
// Express backend for the Sentinel dVPN operator console on Solana.
//   lib/solana/*   chain layer (IDL, RPC pool, program, readers, tx, errors)
//   lib/daemon.js  provider dvpnd gRPC (roster, leases)
//   lib/nodeapi.js signed HTTPS to node / provider APIs
//   lib/session.js keypair | wallet | privy sessions
//   routes/*.js    the API, grouped by page
import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { PORT, DATA_DIR } from './lib/constants.js';
import {
  initSession, decryptSecret, sessionFromKeypair, releaseKeypair, sessionFromWallet, sessionFromPrivy,
  runWithSession, parseCookies, buildClearCookie, buildClearWalletCookie, parseWalletToken,
  COOKIE_NAME, WALLET_COOKIE_NAME,
} from './lib/session.js';
import { initPrivyStore, privyEnabled, signTransaction as privySign, PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_CLIENT_ID } from './lib/privy.js';
import { NETWORK, PROGRAM_ID, MINT } from './lib/solana/idl.js';
import { logRpcCounters } from './lib/solana/rpc.js';
import { daemonTargets } from './lib/daemon.js';
import walletRoutes from './routes/wallet.js';
import providerRoutes from './routes/provider.js';
import planRoutes from './routes/plans.js';
import subscriberRoutes from './routes/subscribers.js';
import nodeRoutes from './routes/nodes.js';
import earningsRoutes from './routes/earnings.js';
import miscRoutes from './routes/misc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
try { mkdirSync(DATA_DIR, { recursive: true }); } catch (err) {
  console.error(`[boot] Cannot create DATA_DIR ${DATA_DIR}:`, err.message);
  process.exit(1);
}
initSession(DATA_DIR);
initPrivyStore(DATA_DIR);

{
  const vars = [['PRIVY_APP_ID', PRIVY_APP_ID], ['PRIVY_APP_SECRET', PRIVY_APP_SECRET], ['PRIVY_CLIENT_ID', PRIVY_CLIENT_ID]];
  const set = vars.filter(([, v]) => v && v.trim());
  if (set.length > 0 && set.length < 3) {
    console.warn(`[privy] Partial config: ${set.length}/3 vars set. Missing: ${vars.filter(([, v]) => !v).map(([k]) => k).join(', ')}.`);
  }
}

const app = express();
app.use(express.json({ limit: '512kb' }));
app.disable('x-powered-by');
// TRUST_PROXY: Express 'trust proxy' value (default loopback). Set to "false" when no
// proxy is in front, otherwise a local client could spoof X-Forwarded-For past the rate limits.
app.set('trust proxy', ['false', '0'].includes(String(process.env.TRUST_PROXY || '').toLowerCase()) ? false : (process.env.TRUST_PROXY || 'loopback'));

// ─── Security headers ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; "
    + "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; "
    + "style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data: https:; "
    + "connect-src 'self' https://auth.privy.io https://*.privy.io https://*.rpc.privy.systems https://api.coingecko.com; "
    + "object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── CSRF: non-GET must be same-origin, allow-listed, or carry X-Requested-With ──
const EXTRA_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
function isSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch (err) { return false; }
}
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (isSameOrigin(req)) return next();
  if (origin && EXTRA_ALLOWED_ORIGINS.includes(origin)) return next();
  if (!origin && req.headers['x-requested-with'] === 'XMLHttpRequest') return next();
  return res.status(403).json({ error: 'CSRF blocked', errorCode: 'csrf' });
});

app.use(express.static(join(__dirname, 'public'), {
  setHeaders(res, path) {
    if (path.endsWith('.mjs')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  },
}));

// ─── Per-request session ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const secretToken = cookies[COOKIE_NAME];
  const walletToken = cookies[WALLET_COOKIE_NAME];

  if (secretToken) {
    try {
      const keypair = decryptSecret(secretToken);
      const session = sessionFromKeypair(keypair);
      res.on('close', () => releaseKeypair(session));
      return runWithSession(session, () => next());
    } catch (err) {
      console.warn('[session] Rejecting key cookie:', err.message);
      res.setHeader('Set-Cookie', buildClearCookie({ secure: req.secure }));
    }
  }
  if (walletToken) {
    const parsed = parseWalletToken(walletToken);
    if (parsed) {
      const session = parsed.kind === 'privy'
        ? sessionFromPrivy(parsed.pubkey, parsed.walletId, privySign)
        : sessionFromWallet(parsed.pubkey);
      return runWithSession(session, () => next());
    }
    console.warn('[session] Rejecting wallet cookie (bad signature or expired)');
    res.setHeader('Set-Cookie', buildClearWalletCookie({ secure: req.secure }));
  }
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use(walletRoutes);
app.use(providerRoutes);
app.use(planRoutes);
app.use(subscriberRoutes);
app.use(nodeRoutes);
app.use(earningsRoutes);
app.use(miscRoutes);

// SPA fallback for deep links.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/health')) return next();
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/health')) {
    return res.status(404).json({ ok: false, error: `No such endpoint: ${req.method} ${req.path}`, errorCode: 'not-found' });
  }
  next();
});

// JSON error handler — must be last and must have 4 args.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  let errorCode = err.errorCode || 'server-error';
  if (err.type === 'entity.too.large' || status === 413) errorCode = 'payload-too-large';
  else if (err.type === 'entity.parse.failed') errorCode = 'bad-json';
  if (status >= 500) console.error('[error-handler]', req.method, req.path, '-', err.message);
  if (res.headersSent) return next(err);
  res.status(status).json({ ok: false, error: status === 413 ? 'Request too large' : (err.message || 'Internal server error'), errorCode });
});

// ─── Start ───────────────────────────────────────────────────────────────────
try {
  const envPath = join(__dirname, '.env');
  // Windows has no group/world mode bits (stat reports 0o666 for every file), so the check only means something on POSIX.
  if (process.platform !== 'win32' && existsSync(envPath) && (statSync(envPath).mode & 0o044)) {
    process.stderr.write('[security] WARNING: .env has group/world read permissions. Run: chmod 600 .env\n');
  }
} catch (err) {
  console.warn('[security] .env permission check failed:', err.message);
}

// Loopback by default: the console signs with a loaded wallet, so it should not face the LAN
// unless someone opts in (HOST=0.0.0.0 behind a firewall or reverse proxy).
const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Plan Manager (Solana) on http://${displayHost}:${PORT} · network=${NETWORK} program=${PROGRAM_ID.toBase58()} mint=${MINT.toBase58()}`);
  console.log(`[boot] privy=${privyEnabled() ? 'enabled' : 'off'} · provider daemons configured: ${daemonTargets().size}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[boot] Port ${PORT} is already in use. Stop the other process or set PORT=<free port> in .env.`);
    process.exit(1);
  }
  console.error('[boot] Server failed to start:', err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);
  logRpcCounters('at shutdown');
  server.close(() => { console.log('Server closed.'); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
