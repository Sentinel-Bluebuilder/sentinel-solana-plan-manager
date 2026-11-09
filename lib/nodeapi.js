// ─── Signed HTTPS to node / provider daemons ─────────────────────────────────
// Mirrors sentinel-go-sdk/auth/{auth,request,ticket}.go @ cb33092e byte for byte.
//
// Request signature (X-Sentinel-Signer/Nonce/Signature/Timestamp headers):
//   sig = ed25519( domain32 ‖ msg )
//   domain32 = sha256("sentinel-dvpn/api-request/v1")   (cb33; was zero-padded text)
//   msg = u8 len(method) ‖ method ‖ u16le len(path) ‖ path ‖ u64le signedAt ‖ nonce16 ‖ sha256(body)
// Ticket request (provider POST /v1/tickets, body {"ticket_request": base64}):
//   borsh { u8 version=1, subscription32, node32, provider32, i64 requestedAt, nonce16 }
//   signed under sha256("sentinel-dvpn/ticket-request/v1"); wire = borsh { request, signer32, sig64 }
// Ticket (provider reply): borsh Ticket signed under sha256("sentinel-dvpn/ticket/v1").
//
// TLS: daemons use self-signed certs and advertise a sha256 pin of the
// certificate in /v1/metadata (payload.api.tls_sha256). When a pin is given the
// handshake is torn down on mismatch BEFORE any request byte is sent; without
// one (first contact) the certificate is accepted as presented.
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';

export const MAX_REQUEST_SKEW_S = 60;

/** cb33 auth.NewDomain: sha256 of the tag text. */
export function domain(tag) {
  return createHash('sha256').update(tag, 'utf8').digest();
}

export const DOMAIN_API_REQUEST = domain('sentinel-dvpn/api-request/v1');
export const DOMAIN_TICKET_REQUEST = domain('sentinel-dvpn/ticket-request/v1');
export const DOMAIN_TICKET = domain('sentinel-dvpn/ticket/v1');

export function signDomain(secretKey, dom, msg) {
  return Buffer.from(nacl.sign.detached(Buffer.concat([dom, msg]), secretKey));
}

export function verifyDomain(pubkey, dom, msg, sig) {
  return nacl.sign.detached.verify(Buffer.concat([dom, msg]), sig, new PublicKey(pubkey).toBytes());
}

export function requestMessage(method, path, body, signedAt, nonce) {
  const m = Buffer.from(method, 'utf8');
  const p = Buffer.from(path, 'utf8');
  const out = Buffer.alloc(1 + m.length + 2 + p.length + 8 + 16 + 32);
  let o = 0;
  out.writeUInt8(Math.min(m.length, 255), o); o += 1;
  m.copy(out, o); o += m.length;
  out.writeUInt16LE(Math.min(p.length, 65535), o); o += 2;
  p.copy(out, o); o += p.length;
  out.writeBigUInt64LE(BigInt.asUintN(64, BigInt(signedAt)), o); o += 8;
  nonce.copy(out, o); o += 16;
  createHash('sha256').update(body || Buffer.alloc(0)).digest().copy(out, o);
  return out;
}

export function signRequest(keypair, method, path, body, now = Math.floor(Date.now() / 1000)) {
  const nonce = randomBytes(16);
  const sig = signDomain(keypair.secretKey, DOMAIN_API_REQUEST, requestMessage(method, path, body, now, nonce));
  return {
    'X-Sentinel-Signer': keypair.publicKey.toBase58(),
    'X-Sentinel-Nonce': nonce.toString('base64'),
    'X-Sentinel-Signature': sig.toString('base64'),
    'X-Sentinel-Timestamp': String(now),
  };
}

// ─── ticket request / ticket ─────────────────────────────────────────────────
export function encodeTicketRequest({ subscription, node, provider, requestedAt, nonce }) {
  const out = Buffer.alloc(1 + 32 * 3 + 8 + 16);
  let o = 0;
  out.writeUInt8(1, o); o += 1;
  new PublicKey(subscription).toBuffer().copy(out, o); o += 32;
  new PublicKey(node).toBuffer().copy(out, o); o += 32;
  new PublicKey(provider).toBuffer().copy(out, o); o += 32;
  out.writeBigInt64LE(BigInt(requestedAt), o); o += 8;
  nonce.copy(out, o);
  return out;
}

export function signTicketRequest(keypair, { subscription, node, provider }, now = Math.floor(Date.now() / 1000)) {
  const nonce = randomBytes(16);
  const req = encodeTicketRequest({ subscription, node, provider, requestedAt: now, nonce });
  const sig = signDomain(keypair.secretKey, DOMAIN_TICKET_REQUEST, req);
  const wire = Buffer.concat([req, keypair.publicKey.toBuffer(), sig]);
  return wire.toString('base64');
}

/** Decode a provider-issued ticket (base64 borsh SignedTicket). */
export function decodeTicket(b64) {
  const b = Buffer.from(b64, 'base64');
  let o = 0;
  const version = b.readUInt8(o); o += 1;
  const pk = () => { const k = new PublicKey(b.subarray(o, o + 32)).toBase58(); o += 32; return k; };
  const provider = pk(); const node = pk(); const user = pk(); const subscription = pk();
  const issuedAt = Number(b.readBigInt64LE(o)); o += 8;
  const expiresAt = Number(b.readBigInt64LE(o)); o += 8;
  const dataCapBytes = b.readBigUInt64LE(o).toString(); o += 8;
  const maxConnections = b.readUInt8(o); o += 1;
  const nonce = b.subarray(o, o + 16).toString('base64'); o += 16;
  const ticketBytes = b.subarray(0, o);
  const signer = pk();
  const signature = b.subarray(o, o + 64); o += 64;
  const valid = verifyDomain(signer, DOMAIN_TICKET, ticketBytes, signature);
  const hash = createHash('sha256').update(ticketBytes).digest('hex');
  return { version, provider, node, user, subscription, issuedAt, expiresAt, dataCapBytes, maxConnections, nonce, signer, signatureValid: valid, hash };
}

// ─── HTTPS with optional certificate pin ─────────────────────────────────────
export function httpsRequest(url, { method = 'GET', headers = {}, body = null, pinSha256 = null, timeoutMs = 10_000 } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
      rejectUnauthorized: false, // self-signed daemon certs; trust comes from the pin check on secureConnect
      // A pinned request must not reuse a keep-alive socket that an UNPINNED request (e.g. the
      // metadata read) opened: a fresh connection guarantees the handshake check below runs.
      agent: pinSha256 ? false : undefined,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (err) { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`request to ${url} timed out after ${timeoutMs}ms`)));
    // Node never calls checkServerIdentity for a certificate that failed chain
    // validation (every self-signed daemon cert), so the pin is checked by hand
    // as soon as the handshake completes and before the request is flushed.
    if (pinSha256) {
      const verify = (socket) => {
        const cert = socket.getPeerCertificate();
        const got = cert && cert.raw ? createHash('sha256').update(cert.raw).digest('hex') : '';
        if (got.toLowerCase() !== String(pinSha256).toLowerCase()) {
          const e = new Error(`TLS certificate of ${u.hostname} does not match the provider's advertised pin (got ${got || 'no certificate'})`);
          e.status = 502; e.errorCode = 'tls-pin-mismatch';
          socket.destroy(e); req.destroy(e);
        }
      };
      req.on('socket', (socket) => {
        // Already-open socket (should not happen with agent:false, guarded anyway): check now.
        if (socket.encrypted && !socket.connecting && socket.getPeerCertificate && socket.getPeerCertificate().raw) verify(socket);
        else socket.once('secureConnect', () => verify(socket));
      });
    }
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function signedRequest(keypair, baseUrl, method, path, bodyObj = null, opts = {}) {
  const body = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : Buffer.alloc(0);
  const headers = signRequest(keypair, method, path, body);
  return httpsRequest(new URL(path, baseUrl).toString(), { method, headers, body: body.length ? body : null, ...opts });
}

export async function health(baseUrl, { timeoutMs = 5000 } = {}) {
  return httpsRequest(new URL('/v1/health', baseUrl).toString(), { timeoutMs });
}

export async function metadata(baseUrl, { timeoutMs = 8000 } = {}) {
  return httpsRequest(new URL('/v1/metadata', baseUrl).toString(), { timeoutMs });
}

/** Ask a provider for an access ticket. `keypair` = the subscription owner. */
export async function requestTicket(keypair, providerUri, { subscription, node, provider }, opts = {}) {
  const ticketRequest = signTicketRequest(keypair, { subscription, node, provider });
  const r = await httpsRequest(new URL('/v1/tickets', providerUri).toString(), {
    method: 'POST', body: JSON.stringify({ ticket_request: ticketRequest }), timeoutMs: 30_000, ...opts,
  });
  if (r.status !== 200 || !r.json?.ticket) {
    // The daemon's error field may be a string or an object ({code, message}).
    const raw = r.json ? (r.json.error ?? r.json.message) : null;
    const reason = !raw ? r.text.slice(0, 200) : typeof raw === 'string' ? raw : (raw.message || JSON.stringify(raw)).slice(0, 200);
    const e = new Error(r.status === 200 ? `provider answered without a ticket: ${reason}` : `provider refused the ticket (HTTP ${r.status}): ${reason}`);
    // A 4xx is the provider's verdict on this request (403 = not valid for that
    // node, 401 = our signature / nonce / clock); a 200 without a ticket or a
    // 5xx is a provider fault.
    if (r.status === 200) { e.status = 502; e.errorCode = 'provider-bad-response'; }
    else if (r.status === 401) { e.status = 403; e.errorCode = 'ticket-unauthenticated'; e.message += ' — signature, nonce replay or clock skew > 60 s (check this machine\'s clock)'; }
    else if (r.status >= 400 && r.status < 500) { e.status = r.status === 409 ? 409 : 403; e.errorCode = 'ticket-refused'; }
    else { e.status = 502; e.errorCode = 'provider-unreachable'; }
    e.providerResponse = r.json || r.text;
    throw e;
  }
  return { raw: r.json, ticket: decodeTicket(r.json.ticket) };
}
