# Plan Manager (Solana) — Platform Map

Every page → control → frontend function → API route → on-chain instruction or daemon call. The route ↔ CLI ↔ test matrix is generated into [`docs/COVERAGE.md`](docs/COVERAGE.md) (`node scripts/coverage.mjs`); this file explains the shape.

Backend: `server.js` (bootstrap) + `routes/*.js`. Frontend: `public/index.html` (vanilla JS, pages rendered into `#app`). Every write ends in `broadcastOrRelay()` (`lib/solana/tx.js`): the server simulates, then either signs (key / Privy session) or returns `{mode:'wallet-sign', tx}` for the browser wallet; the browser posts the signed transaction to `/api/tx/broadcast-signed`. The frontend helper `txFetch()` hides that round-trip from every page.

## Sessions

| Mode | Login | Signs |
|---|---|---|
| key | `POST /api/wallet/import` (JSON array, base58, phrase) · `POST /api/wallet/generate` | server, from the AES-256-GCM cookie |
| wallet extension | `POST /api/wallet/challenge` → `signMessage` → `POST /api/wallet/login` | the extension; relay validates fee payer + program allow-list |
| Privy | `POST /api/wallet/privy-login` (access token) | Privy's Solana wallet API |

## Pages

### dashboard
`renderDashboard` → `GET /api/wallet`, `GET /api/my-plans`, `GET /api/nodes/chain-count`, `GET /api/params`, `GET /api/providers/daemon`.

### provider
| Control | Function | Route | Chain / daemon |
|---|---|---|---|
| Register / Update URI | `registerProvider` | `POST /api/provider/register` | `open_provider`+`list_provider` (one tx) or `update_provider` |
| List / Delist | `setProviderStatus` | `POST /api/provider/status` | `list_provider` / `delist_provider` |
| Close | `closeProvider` | `POST /api/provider/close` | `delist_provider`+`close_provider` |
| Withdraw matured bonds | `withdrawBond` | `POST /api/provider/withdraw-bond` | `withdraw_provider_bond` |
| Active provider | `selectProvider` | `POST /api/provider/select` | — |
| (load) | — | `GET /api/providers`, `GET /api/provider/unbonding`, `GET /api/providers/daemon` | `Provider` / `ProviderUnbonding` accounts, daemon `GetProviderInfo` |

### create
| Publish plan | `createPlan` | `POST /api/plan/create` | `open_plan`+`list_plan` (one tx) |

### your-plans
| Control | Function | Route | Chain |
|---|---|---|---|
| (load) | `loadMyPlans` | `GET /api/my-plans` | `Plan` by provider + `Subscription` by plan + daemon roster |
| Edit | `editPlan` | `POST /api/plan/update` | `update_plan` |
| List / Delist | `setPlanStatus` | `POST /api/plan/status` | `list_plan` / `delist_plan` |
| Close | `closePlan` | `POST /api/plan/close` | `delist_plan`+`close_plan` |
| Share | `sharePlan` | `GET /api/plans/:id/share` | — |

### add-nodes
| (load) | `fetchNodeList` | `GET /api/all-nodes` (+ `nodes/progress`, `nodes/chain-count`) | `Node` accounts + health probe |
| Link | `linkBatch` | `POST /api/plan-manager/batch-link` | daemon `AddRosterNodes` → keeper leases |

### your-nodes
| (load) | `loadYourNodes` | `GET /api/plans/:id/members`, `GET /api/leases` | daemon roster, `Lease` accounts + daemon leases |
| Unlink | `unlinkNode` | `POST /api/plan-manager/unlink` | daemon `RemoveRosterNodes` |
| Run keeper | `keepLeases` | `POST /api/lease/keep` | daemon `KeepNow` |
| Close lease | `endLease` | `POST /api/lease/end` | `start_close_lease` / `close_lease` |

### pricing
`loadPricing` → `GET /api/params`, `GET /api/node-rankings`, `GET /api/my-plans`.

### subscribers
| Control | Function | Route | Chain / daemon |
|---|---|---|---|
| (load) | `loadSubscribers` | `GET /api/plans/:id/members`, `GET /api/plans/:id/own-subscription` | `Subscription` accounts |
| Add (free plans) | `addSubscribers` | `POST /api/plan/add-subscribers` | `open_subscription` for each owner |
| Subscribe (test) | `selfSubscribe` | `POST /api/plan/subscribe` | `open_subscription` |
| Request ticket | `requestTicket` | `POST /api/plan/request-ticket` | provider daemon `POST /v1/tickets` (signed) |
| Close | `closeSubscription` | `POST /api/plan/close-subscription` | `close_subscription` |

### earnings
| (load) | `loadEarnings` | `GET /api/earnings` | `Provider`, `User`, `ProviderUnbonding` |
| Withdraw revenue / balance | `withdrawRevenue` / `withdrawBalance` | `POST /api/earnings/withdraw-revenue` / `withdraw-balance` | `withdraw_provider_revenue` / `withdraw_provider_balance` |
| Sweep fees | `sweepFees` | `POST /api/earnings/sweep-fees` | `sweep_provider_fees` |
| Withdraw user balance | `withdrawUserBalance` | `POST /api/earnings/withdraw-user-balance` | `withdraw_user_balance` |

### wallet
`loadWalletPage` → `GET /api/wallet`, `GET /api/wallet/qr`; Send → `doWalletSend` → `POST /api/wallet/send` (System transfer or Token-2022 `transferChecked`); Log out → `POST /api/wallet/logout`.

### fee-grants
Placeholder. `GET /api/feegrant/*` answer `{wip:true}`, `POST /api/feegrant/*` answer 501.

### cli-install / cli-commands
Static.

## Validation & guards
- Addresses are parsed as Solana public keys (PDAs are off-curve and accepted).
- `assertPlanOwnership(planPda)` gates every plan mutation and roster change.
- Batch caps: add-subscribers ≤ 500 addresses (6 gifts per tx), link/unlink ≤ 100 nodes.
- Rate limits: wallet generate 10/min, import 20/min, send 30/min, challenge 30/min, login/privy-login 20/min.
- CSRF: non-GET requests must be same-origin, allow-listed, or carry `X-Requested-With`.
- Relay: fee payer must be the session; programs limited to dvpn, System, Token-2022, Associated Token, Compute Budget; no address-lookup tables.
