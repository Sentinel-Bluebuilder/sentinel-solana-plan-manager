# Contributing

Short on purpose — read it once, then read the code.

## Setup

```bash
git clone https://github.com/Sentinel-Bluebuilder/sentinel-plan-manager-solana.git
cd sentinel-plan-manager-solana
npm install
cp .env.example .env     # RPC pool, provider daemon socket, optional Privy keys
npm run doctor
npm start
```

## Architecture

- `server.js` — bootstrap and middleware only. Routes live in `routes/*.js`, one file per page.
- `lib/solana/` — the chain layer: network-keyed IDL and deployed account sizes, RPC pool with benching, Anchor program + PDA helpers + instruction builders, account readers, simulate/sign/relay, error tables.
- `lib/daemon.js` — gRPC to the provider daemon (roster, leases). `lib/nodeapi.js` — signed HTTPS to node/provider APIs (tickets).
- `lib/session.js` — keypair / wallet-extension / Privy sessions behind one `signTransaction` contract.
- `public/index.html` — the console, vanilla JS. `cli.js` — thin HTTP client and the e2e driver.

## Rules of the road

- **Decode devnet with the devnet IDL.** `chain/idl/dvpn.devnet.json` is generated; never hand-edit it, change `scripts/patch-idl.mjs`. Reads use explicit `dataSize` from `lib/solana/idl.js`; never `program.account.X.all()`.
- **Branch on error numbers**, translate names per network (`lib/solana/errors.js`).
- **One `broadcastOrRelay` per request.** Wallet-extension and Privy sessions sign one transaction per round-trip; bundle instructions instead of looping.
- **The daemon owns roster leases.** Do not add a route that opens a lease for a roster node.
- **No secrets in commits.** `.env`, `.session-key`, `privy-wallets.json`, `keys/`, `.cli-session.json` are ignored.
- **Tests stay green.** `npm test` (unit + route sweep + relay harness) before a PR; `npm run test:e2e` on devnet for anything that touches a write path. Add a CLI command and an e2e step for every new route — `docs/COVERAGE.md` is generated from them.
- **Token naming.** The devnet token is **tDVPN** everywhere in user-facing text; amounts in the API are base-unit strings with a `…Tdvpn` companion field.

## Submitting

1. Work on `master`; keep diffs small — one feature or fix per PR.
2. Update `PLANS.md` if you add a chain interaction, `README.md` if you add a page or command.
3. PR against `Sentinel-Bluebuilder/sentinel-plan-manager-solana`.
