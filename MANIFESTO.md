# The Plan Manager Manifesto

> *"A protocol without commerce is a library. A protocol with commerce is an economy."*

---

## Why this exists

The Sentinel program on Solana gives you nodes, leases, plans and subscriptions as on-chain accounts, and a provider daemon that turns a subscription into a tunnel. None of that is a *business* until someone registers a provider, publishes a plan, links the nodes and opens the door for subscribers.

That is what this console is: the commerce layer. Without it, the network is infrastructure waiting to be used. With it, anyone with a wallet can run an internet service provider from a laptop.

## The vision

Starting an ISP should take five minutes and cost nothing but a bond.

An operator registers a provider, publishes a plan — 100 GB, 30 days, 5 tDVPN — links three nodes on three continents, and shares a plan address. People subscribe. The program pays the provider on chain. The daemon leases the nodes automatically. Earnings are withdrawn with one click. No permission asked, no telecom negotiated, no intermediary holding the money.

## Principles

1. **Chain is the database.** Plans, subscriptions, leases and balances are read from the program every time. The console keeps no ledger of its own.
2. **One transaction where one transaction will do.** Register + list, open + list, delist + close: atomic, so nothing is ever half-published.
3. **Simulate before anyone signs.** A program error is a named response, not a failed wallet popup.
4. **The daemon owns the roster and the leases.** The console links and unlinks; it never opens a lease behind the keeper's back.
5. **Keys stay where the user put them.** Key sessions are encrypted into the user's own cookie; extension and Privy sessions never give the server a key at all.
6. **Everything scriptable.** Every page is a CLI command; the end-to-end suite runs the whole operator lifecycle on live devnet through that CLI.
7. **Honest about limits.** Priced subscriptions are bought by the subscriber only; fee sponsorship does not exist yet; billing counts wire bytes. The console says so instead of hiding it.
