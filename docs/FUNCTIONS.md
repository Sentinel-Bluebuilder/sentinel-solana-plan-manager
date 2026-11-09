# Function map — every `dvpn` instruction and daemon method vs this console

Which of the program's 47 instructions and the provider daemon's methods the operator console drives, which belong to another role, and which Cosmos-era functions have no Solana counterpart. Route-level coverage is in [`COVERAGE.md`](COVERAGE.md).

Legend: **console** = driven by this console/CLI and proven in `scripts/cli-e2e.mjs` on devnet (rows marked *refusal-tested* have only their guard paths tested: the positive path is destructive or needs a balance the rig cannot produce) · **daemon** = performed by the provider `dvpnd` on the console's behalf · **node operator** = belongs to the node-operator tooling, not a plan operator · **client** = belongs to the subscriber's client · **governance** = program authority only.

## Provider (9 instructions)

| Instruction | Who | How here |
|---|---|---|
| `open_provider` | console | `provider register` (bundled with `list_provider`) |
| `update_provider` | console | `provider register --uri` on an existing provider |
| `list_provider` / `delist_provider` | console | `provider status` |
| `close_provider` | console | `provider close` (refused while plans/leases are open) — *refusal-tested* |
| `withdraw_provider_bond` | console | `provider withdraw-bond` after `unbonding_seconds` — *refusal-tested* |
| `withdraw_provider_revenue` | console | `earnings withdraw-revenue` |
| `withdraw_provider_balance` | console | `earnings withdraw-balance` — *refusal-tested* (needs a closed-lease refund) |
| `sweep_provider_fees` | console | `earnings sweep-fees` (providers as sorted remaining accounts) |

## Plan (5)

| Instruction | Who | How here |
|---|---|---|
| `open_plan` | console | `plan create` (bundled with `list_plan`) |
| `update_plan` | console | `plan update` |
| `list_plan` / `delist_plan` | console | `plan status` |
| `close_plan` | console | `plan close` (bundled with `delist_plan`) |

## Subscription / user (3)

| Instruction | Who | How here |
|---|---|---|
| `open_subscription` | console (free gifts, self-subscribe) / client (priced) | `subscriber add`, `subscriber subscribe`; priced plans: `plan share` |
| `close_subscription` | console (owner, provider for free subs, anyone after expiry) | `subscriber close` |
| `withdraw_user_balance` | console | `earnings withdraw-user-balance` — *refusal-tested* (needs a channel refund) |

## Lease (6)

| Instruction | Who | How here |
|---|---|---|
| `open_lease`, `fund_leases` | daemon | lease keeper, triggered by roster membership (`nodes link`, `lease keep`) |
| `start_close_lease`, `close_lease` | daemon; console for strays | keeper on `nodes unlink`; `lease end` closes a lease the roster no longer references, and refuses with 409 `lease-in-roster` while any plan still routes the node (`--force` overrides) — console close is *refusal-tested* (the rig's only lease is the keeper's) |
| `redeem_lease_vouchers`, `redeem_lease_streams` | node operator | the node redeems what the provider's lease owes it |

## Node (8)

`open_node`, `update_node`, `list_node`, `delist_node`, `close_node`, `withdraw_node_bond`, `withdraw_node_revenue`, `sweep_node_fees` — **node operator**. Out of scope for a plan operator; covered by the node-manager tooling. The console only *reads* `Node` accounts (discovery, health probe, pricing).

## Channel (6)

`open_channel`, `fund_channels`, `redeem_channel_vouchers`, `redeem_channel_streams`, `start_close_channel`, `close_channel` — **client / node** (direct pay-per-use between a user and a node, no provider involved). Not a plan-operator function. The console surfaces the resulting `User.balance` refunds via `withdraw_user_balance`.

## Operator mandate (3)

`add_operator`, `update_operator`, `remove_operator` — **not surfaced yet**. They let a device key act for the owner with an allowance; the provider daemon uses one (it signs leases with its operator key under the owner's mandate). The console signs as the owner, so it never needs a mandate of its own. Worth adding only if operators want to run the console with a delegated key instead of the owner key; note divergence 5 in the Solana docs (never remove a mandate while its channels are open).

## Governance (7)

`initialize_config`, `set_params`, `set_treasury`, `set_paused`, `propose_authority`, `accept_authority`, `sweep_config_fees` — **governance** (program authority `AiBSirxW…`). Read-only here (`params show`).

## Provider daemon gRPC (`ProviderService`, 8 methods)

| Method | Console |
|---|---|
| `GetProviderInfo` | `provider daemon`, mismatch guard before every roster change |
| `ListRosterNodes` | `plan members`, `nodes list --plan`, link/unlink responses |
| `AddRosterNodes` / `RemoveRosterNodes` | `nodes link` / `nodes unlink` |
| `ListLeases` | `lease list` |
| `KeepNow` | `lease keep` |
| `ListIssuedTickets` | not surfaced — the daemon's ticket log; add a `provider tickets` read if operators want to see sessions issued |
| `ProbeNow` | not surfaced — forces a node probe; the keeper probes on its own schedule |

`DaemonService.GetVersion` → `provider daemon` / `health daemons`. `ClientService` and `NodeService` are the client and node roles.

## Provider HTTP API (`providerapi`)

`POST /v1/tickets` → `subscriber ticket` (the console signs a ticket request as the subscriber to prove the plan is serviceable). `GET /v1/health`, `/v1/metadata`, `/v1/nodes`, `/v1/plans/{plan}/nodes` are what subscriber clients call; the console reads the roster over gRPC instead.

## Cosmos-era functions with no Solana counterpart

| Former function | Status |
|---|---|
| Fee grants (`MsgGrantAllowance` / `MsgRevokeAllowance`) | no standing allowance object on Solana; page kept as work in progress; sponsorship would be a co-signed `rent_payer` |
| Share subscription (`MsgShareSubscription`) | no on-chain equivalent; `max_connections` on the plan is the nearest control; free-plan gifting covers "give access" |
| Renew subscription | no instruction; subscribers open a new subscription after expiry |
| Start session on chain (`MsgStartSession`) | sessions are off-chain tickets; `subscriber ticket` is the test |
| Per-node session query | not on chain; the node daemon exposes it locally |
| Multi-denom pricing, USD spot price | single token (tDVPN); `params price` returns the market price on mainnet only |

## Redundancies removed in this rebuild

`/api/lease/start` (alias of `lease/keep`), `/api/plan/start-session` (alias of `request-ticket`), `/api/rpcs` + `/api/rpc-providers` (same as `/health/rpc`), `/api/nodes/:addr/sessions` (always 501), `my-plans.json` (chain is the database), the three Cosmos RPC endpoint pools, the LCD fallback layer, the per-denom logo tables, the payment-rail pages.

## Candidates to add (not blocking)

1. `provider tickets` (daemon `ListIssuedTickets`) — a sessions-issued view for operators.
2. `provider probe` (daemon `ProbeNow`) — force a roster probe from the console.
3. Operator-mandate sessions — run the console with a delegated key (`add_operator` with the provider role, allowance-capped).
4. Fee sponsorship — co-sign a subscriber's `open_subscription` as `rent_payer` (needs a subscriber-side flow).
