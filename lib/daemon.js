// ─── Provider daemon gRPC client ─────────────────────────────────────────────
// Node linking lives in the provider dvpnd: its roster (plan ↔ node bindings)
// and its lease keeper (opens / funds / closes the leases those bindings need).
// This module speaks sentinel.daemon.v1.ProviderService over the daemon's
// control socket, exactly as `dvpnctl provider nodes add|list|remove` does.
//
// DVPND_PROVIDER_SOCKETS maps a provider PDA to a gRPC target:
//   <pda>=unix:///root/dvpnd-provider/daemon.sock   (same host, Linux)
//   <pda>=127.0.0.1:50052                           (scripts/dev/daemon-bridge.py)
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PROTO = join(here, '..', 'proto', 'daemon.proto');
const DEADLINE_MS = 20_000;
const GRPC_TO_HTTP = {
  [grpc.status.UNAVAILABLE]: 503,
  [grpc.status.DEADLINE_EXCEEDED]: 504,
  [grpc.status.NOT_FOUND]: 404,
  [grpc.status.FAILED_PRECONDITION]: 409,
  [grpc.status.ALREADY_EXISTS]: 409,
  [grpc.status.ABORTED]: 409,
  [grpc.status.INVALID_ARGUMENT]: 400,
  [grpc.status.PERMISSION_DENIED]: 403,
  [grpc.status.UNAUTHENTICATED]: 403,
};

let _pkg = null;
function pkg() {
  if (_pkg) return _pkg;
  const def = protoLoader.loadSync(PROTO, { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true });
  _pkg = grpc.loadPackageDefinition(def).sentinel.daemon.v1;
  return _pkg;
}

export function daemonTargets() {
  const out = new Map();
  for (const entry of (process.env.DVPND_PROVIDER_SOCKETS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf('=');
    if (i < 0) { console.warn(`[daemon] ignoring malformed DVPND_PROVIDER_SOCKETS entry "${entry}"`); continue; }
    out.set(entry.slice(0, i).trim(), entry.slice(i + 1).trim());
  }
  return out;
}

/**
 * Optional per-provider override of the HTTPS API base the console should use
 * instead of the on-chain `uri` (dev rigs where the daemon sits behind a
 * bridge): DVPND_PROVIDER_APIS="<providerPda>=https://127.0.0.1:19443,…".
 */
export function providerApiOverrides() {
  const out = new Map();
  for (const entry of (process.env.DVPND_PROVIDER_APIS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf('=');
    if (i > 0) out.set(entry.slice(0, i).trim(), entry.slice(i + 1).trim());
  }
  return out;
}

const clients = new Map();
function clientFor(target) {
  let c = clients.get(target);
  if (!c) {
    const P = pkg();
    const creds = grpc.credentials.createInsecure();
    c = {
      target,
      provider: new P.ProviderService(target, creds),
      daemon: new P.DaemonService(target, creds),
    };
    clients.set(target, c);
  }
  return c;
}

function call(stub, method, req = {}) {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + DEADLINE_MS);
    stub[method](req, { deadline }, (err, res) => {
      if (err) {
        const e = new Error(`daemon ${method}: ${err.details || err.message}`);
        e.grpcCode = err.code;
        e.status = GRPC_TO_HTTP[err.code] || 502;
        reject(e);
        return;
      }
      resolve(res);
    });
  });
}

export class DaemonUnavailableError extends Error {
  constructor(providerPda) {
    super(`No provider daemon configured for ${providerPda}. Set DVPND_PROVIDER_SOCKETS=<providerPda>=<socket> and start the daemon.`);
    this.name = 'DaemonUnavailableError';
    this.status = 503;
    this.errorCode = 'provider-daemon-unavailable';
  }
}

/** Client bound to the daemon that serves `providerPda`, or throws 503. */
export function providerDaemon(providerPda) {
  const target = daemonTargets().get(providerPda);
  if (!target) throw new DaemonUnavailableError(providerPda);
  const c = clientFor(target);
  return {
    target,
    version: () => call(c.daemon, 'getVersion'),
    info: () => call(c.provider, 'getProviderInfo').then((r) => r.info),
    listRoster: () => call(c.provider, 'listRosterNodes').then((r) => r.nodes || []),
    addRoster: (plan, nodes) => call(c.provider, 'addRosterNodes', { plan, nodes }),
    removeRoster: (plan, nodes) => call(c.provider, 'removeRosterNodes', { plan, nodes }),
    listLeases: () => call(c.provider, 'listLeases').then((r) => r.leases || []),
    listTickets: () => call(c.provider, 'listIssuedTickets').then((r) => r.tickets || []),
    probeNow: () => call(c.provider, 'probeNow'),
    keepNow: () => call(c.provider, 'keepNow'),
  };
}

/**
 * Same as providerDaemon() but also asserts the daemon really serves that
 * provider (409 otherwise). Use before any roster mutation.
 */
export async function providerDaemonChecked(providerPda) {
  const d = providerDaemon(providerPda);
  const info = await d.info();
  if (info.address !== providerPda) {
    const e = new Error(`Daemon at ${d.target} serves provider ${info.address}, not ${providerPda}`);
    e.status = 409; e.errorCode = 'daemon-provider-mismatch';
    throw e;
  }
  return { daemon: d, info };
}

/** Health view for every configured daemon (never throws). */
export async function daemonsHealth() {
  const out = [];
  for (const [providerPda, target] of daemonTargets()) {
    try {
      const d = providerDaemon(providerPda);
      const [v, info] = await Promise.all([d.version(), d.info()]);
      out.push({ providerPda, target, ok: true, version: v, info });
    } catch (err) {
      out.push({ providerPda, target, ok: false, error: err.message });
    }
  }
  return out;
}
