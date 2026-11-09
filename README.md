# Sentinel Plan Manager — Solana

**The operator console for the Sentinel dVPN on Solana.**

Register a provider, publish subscription plans, link nodes through your provider daemon, manage subscribers and withdraw earnings — every action is a transaction on the Sentinel `dvpn` program, driven from a browser console or a CLI. Chain is the database: there is no server-side store of plans, subscribers or balances.

Status: **devnet**. Program `J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs`, test token **tDVPN** (Token-2022, 6 decimals). Mainnet is a config change (`SOLANA_NETWORK=mainnet` + program id + mint).

---

## What it does

| Page | On chain / in the daemon |
|---|---|
| **Provider** | `open_provider` + `list_provider` in one tx (bond `min_provider_bond` tDVPN), `update_provider`, `list_provider` / `delist_provider`, `close_provider`, `withdraw_provider_bond` after the unbonding window |
| **Create Plan** | `open_plan` + `list_plan` in one tx: price (tDVPN, 0 = free), duration, data cap (0 = unlimited), max connections |
| **Your Plans** | `update_plan` (terms are mutable; buyers are protected by `PlanTermsChanged`), `list_plan` / `delist_plan`, `delist_plan` + `close_plan` in one tx, share command |
| **Add Nodes / Your Nodes** | on-chain node discovery (`Node` accounts, listed + live + health probe); linking is the provider daemon's roster (`AddRosterNodes` / `RemoveRosterNodes` over gRPC). The daemon's lease keeper opens, tops up and closes the node leases; the console shows them and can close a stray one |
| **Subscribers** | `Subscription` accounts by plan; free plans can be gifted (`open_subscription` with another owner); priced plans are self-serve (the program pins the buyer as signer) so the console shares the plan; self-subscribe to test; request an access ticket from the provider daemon (signed off-chain, proves the plan is serviceable); `close_subscription` |
| **Earnings** | `withdraw_provider_revenue`, `withdraw_provider_balance`, `sweep_provider_fees`, `withdraw_user_balance`, parked bonds |
| **Wallet** | SOL + tDVPN balances, QR, send SOL / tDVPN (Token-2022 `transferChecked`, creates the recipient's token account) |
| **Pricing** | program parameters (fee, bonds, grace, listing TTL), your plan pricing net of the protocol fee, cheapest live nodes |
| **Fee Grants** | work in progress — Solana has no standing fee allowance; the page is a placeholder |

Three sign-in modes, one write path:

- **Key session** — paste a `solana-keygen` JSON array, base58 secret key or 12/24-word phrase (derived at `m/44'/501'/0'/0'`). AES-256-GCM in an httpOnly cookie; nothing persisted server-side.
- **Wallet extension** — Phantom, Solflare, Backpack (any `window.solana` provider). The server builds and simulates the transaction, the extension signs it, the server relays it. The relay only accepts transactions whose fee payer is the session and whose programs are allow-listed.
- **Privy** — email/OTP login with a Privy Solana embedded wallet; Privy signs.

Every write is simulated before anyone signs, so program errors come back as plain-language 4xx responses (the program's error name and code stay in the `programError` field), not as a failed wallet popup.

---

## Download

Latest release: [**Releases**](https://github.com/Sentinel-Bluebuilder/sentinel-solana-plan-manager/releases/latest)

| What | Linux x86_64 | Linux arm64 |
|---|---|---|
| Node daemon `sentinel-dvpnd` | `sentinel-dvpnd-linux-amd64` | `sentinel-dvpnd-linux-arm64` |
| Node CLI `sentinel-dvpn` | `sentinel-dvpn-linux-amd64` | `sentinel-dvpn-linux-arm64` |

The Plan Manager itself runs from source (see below). The release carries the daemon and CLI binaries it drives
(built from the Sentinel fork cut `final6.1`), `SHA256SUMS` and the third-party notices.
Some releases ship only the x86_64 binaries.

> **Devnet only, unsigned builds.** Tokens on Solana devnet have no value.

Verify: put `SHA256SUMS` and the files you downloaded in one folder, then
`sha256sum -c --ignore-missing SHA256SUMS`.

Build from source: `npm ci` then `npm test` (see the sections below for running).

Test results and known issues:
[sentinel-solana-dvpn-testing-tools](https://github.com/Sentinel-Bluebuilder/sentinel-solana-dvpn-testing-tools)
([known issues](https://github.com/Sentinel-Bluebuilder/sentinel-solana-dvpn-testing-tools/blob/main/docs/known-issues-rc1.md)).
## Run it

```bash
git clone https://github.com/Sentinel-Bluebuilder/sentinel-solana-plan-manager
cd sentinel-solana-plan-manager
npm install                # also patches the IDL for devnet and bundles the browser vendor files
cp .env.example .env       # set SOLANA_RPC_URLS (a dedicated RPC first), DVPND_PROVIDER_SOCKETS, Privy keys
npm run doctor
node server.js             # http://localhost:3003
```

**Provider daemon.** Node linking and lease keeping live in your `dvpnd` provider daemon (`sentinel-dvpnd`, Linux). Point the console at its control socket:

```
DVPND_PROVIDER_SOCKETS=<providerPda>=unix:///path/to/dvpnd-provider/daemon.sock
```

On Windows with the daemon in WSL2, `scripts/dev/wsl-up.sh` starts the node and provider daemons plus two loopback bridges (gRPC `127.0.0.1:50052`, provider API `127.0.0.1:19443`); then `DVPND_PROVIDER_SOCKETS=<providerPda>=127.0.0.1:50052`.

**RPC.** Use a dedicated endpoint first in `SOLANA_RPC_URLS`; the public devnet RPC rate-limits `getProgramAccounts`. The pool benches a throttled endpoint and rotates.

---

## CLI

```bash
npm link                                  # puts `plans` on PATH (or: node cli.js …)
plans wallet import --file ~/.config/solana/id.json
plans provider register --uri https://your-daemon:9443   # the daemon's PUBLIC https address
plans plan create --duration 2592000 --price 5 --cap 100 --max 2
plans nodes link <plan> <node…>
plans plan members <plan>
plans earnings withdraw-revenue
plans --help                              # every group and command
```

Append `--json` for scripts. The end-to-end suite drives every function through this CLI.

---

## Tests

```bash
npm test               # unit (decoders, PDAs, error tables, signing, sessions) + route sweep + wallet-relay harness
npm run test:e2e       # scripts/cli-e2e.mjs: every function on live devnet through the CLI, self-cleaning
```

The route sweep forces every write down its validation branch without spending. The relay harness plays a wallet extension with a local keypair and proves the challenge/login and sign/relay path, including both 403 refusals. The e2e suite needs a funded wallet (`TEST_KEYFILE`) and the provider daemon; it creates plans and subscriptions, links a node, requests a ticket, withdraws revenue, and closes everything it opened. `docs/COVERAGE.md` maps every route to its CLI command and e2e step.

---

## Layout

```
server.js              bootstrap, middleware, session cookie
routes/                wallet · provider · plans · subscribers · nodes · earnings · misc
lib/solana/            idl (network-keyed, devnet layout compat) · rpc pool · program + PDAs · account readers · tx build/sign/relay · error tables
lib/                   session (keypair | wallet | privy) · daemon (gRPC) · nodeapi (signed HTTPS, tickets) · privy · cache · http · errors
chain/idl/             dvpn.source.json (upstream) · dvpn.devnet.json (generated by scripts/patch-idl.mjs)
proto/daemon.proto     provider daemon control API
public/index.html      the console (vanilla JS single page)
cli.js                 thin HTTP client; the e2e driver
scripts/               tests, dev rig, IDL patch, vendor bundler
```

## Devnet layout

Since upstream upgraded the devnet program to `cb33092e` (2026-11-02), devnet uses the upstream source IDL as is. `chain/idl/dvpn.source.json` is copied verbatim from upstream `sentinel-programs/idl/dvpn.json`; `scripts/patch-idl.mjs` only stamps the devnet program address into `chain/idl/dvpn.devnet.json`. `lib/solana/idl.js` carries the deployed account sizes, and reads use `getProgramAccounts` with explicit sizes. On mainnet set `SOLANA_NETWORK=mainnet`.

## License

Built on Sentinel. <https://sentinel.co>

The code in this repository is under the [Sentinel dVPN License](LICENSE), as are the files vendored from Sentinel ([upstream text](https://github.com/sentinel-official/sentinel-solana/blob/main/LICENSE)):

- `chain/idl/dvpn.source.json` and `chain/idl/dvpn.devnet.json` (the `dvpn` program IDL)
- `proto/daemon.proto` (the dvpnd gRPC interface)

The console shows the attribution in its sidebar and the CLI prints it in `--help`. See `NOTICE`.
