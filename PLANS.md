# Sentinel dVPN Subscription Plans on Solana — Deep Dive

A technical reference for operators launching a commercial dVPN service on Sentinel's Solana program.

---

## 1. The actors

| Account | What it is | Who signs for it |
|---|---|---|
| **Provider** | a bonded on-chain identity that owns plans and leases; `uri` points at the provider daemon that issues access tickets | the owner wallet (or an operator key under an `OperatorMandate` with the provider role) |
| **Plan** | price (tDVPN base units), `duration_seconds`, `data_cap_gb` (0 = unlimited), `max_connections`, status listed/delisted | the provider owner |
| **Subscription** | one per (owner, plan): `opened_at`, `expires_at`, the terms frozen at purchase | the subscriber; a provider may open a **free** subscription for anyone |
| **Node** | a bonded dVPN server advertising prices, protocols, country and URI; a listing expires after `node_listing_ttl_seconds` unless the node heartbeats | the node operator |
| **Lease** | the provider's escrow on a node (pay-per-hour stream or voucher mode) that lets subscribers use it | the provider — in practice the provider **daemon** |

PDAs: `provider = [provider, owner, provider_id]`, `plan = [plan, provider, plan_id]`, `subscription = [subscription, owner, plan]`, `lease = [lease, provider, lease_id]`, `node = [node, owner, node_id]`.

## 2. Money flow

1. The subscriber pays `plan.price` tDVPN into the program vault at `open_subscription`. The protocol fee (`fee_bps`, 2% on devnet) accrues on the provider; the rest is the provider's **revenue**. There is no refund on `close_subscription`.
2. The provider's daemon keeps a **lease** on every roster node, pre-paying the node's `lease_price_per_hour`. Unredeemed escrow returns to the provider **balance** when the lease closes.
3. The provider withdraws revenue (`withdraw_provider_revenue`) and balance (`withdraw_provider_balance`) to its token account whenever it likes, and sweeps accrued fees to the treasury (`sweep_provider_fees`, callable by anyone).
4. Bonds (`min_provider_bond`, `min_node_bond`) are returned after the unbonding window once the provider or node is closed.

## 3. The operator lifecycle, instruction by instruction

| Step | Instruction(s) | Console / CLI |
|---|---|---|
| Register | `open_provider` + `list_provider` (one tx) | Provider page · `plans provider register --uri` |
| Publish a plan | `open_plan` + `list_plan` (one tx) | Create Plan · `plans plan create` |
| Change terms | `update_plan` (any subset of the four terms) | Your Plans → Edit · `plans plan update` |
| Pause / resume sales | `delist_plan` / `list_plan` | Your Plans · `plans plan status` |
| Link nodes | daemon `AddRosterNodes` → keeper `open_lease` / `fund_leases` | Add Nodes · `plans nodes link` |
| Unlink nodes | daemon `RemoveRosterNodes` → keeper `start_close_lease` / `close_lease` | Your Nodes · `plans nodes unlink` |
| Gift a free subscription | `open_subscription` (owner ≠ signer, price 0) | Subscribers · `plans subscriber add` |
| Sell a priced subscription | `open_subscription` by the subscriber | share the plan · `plans plan share` |
| Serve a session | provider daemon issues a signed **ticket**; the client presents it to the node | `plans subscriber ticket` (test) |
| End a subscription | `close_subscription` (owner any time; anyone after expiry; provider for free ones) | Subscribers · `plans subscriber close` |
| Retire a plan | `delist_plan` + `close_plan` (one tx) | Your Plans → Close · `plans plan close` |
| Take earnings | `withdraw_provider_revenue`, `withdraw_provider_balance`, `sweep_provider_fees` | Earnings · `plans earnings …` |
| Leave | `delist_provider`, `close_provider`, then `withdraw_provider_bond` after `unbonding_seconds` | Provider page · `plans provider close` / `withdraw-bond` |

## 4. Sessions and tickets

Subscribers never transact per session. Their client asks your provider daemon for an **access ticket** (`POST /v1/tickets`, body signed under `sentinel-dvpn/ticket-request/v1`), the daemon checks the subscription on chain, enforces `max_connections` and the data cap, and signs a ticket the node accepts. The console's "Request ticket" button runs exactly this request with the operator's own subscription to prove the plan is serviceable end to end.

## 5. What a subscriber needs

- A Solana wallet with **tDVPN** for the plan price and a little **SOL** for the transaction fee and the subscription account's rent (~0.0025 SOL, refunded when the subscription is closed).
- For priced plans the subscriber signs the purchase themself: the program requires `owner == signer`. Share the plan address (or the `dvpnctl subscription open-subscription …` command the console prints).

## 6. Errors you will meet

The devnet deployment numbers errors 6022–6039 one lower than the source IDL; the console and CLI translate them. Common ones: `PlanNotListed`, `ProviderNotListed`, `PlanTermsChanged` (refresh and retry), `OpenPlansRemain` / `OpenLeasesRemain` (close them before closing the provider), `UnbondingNotElapsed`, `NodeNotListed`, `InsufficientRevenue`. Solana-level failures surface as "insufficient SOL for fees or rent" or "insufficient tDVPN balance".
