<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- trenchytools:agents -->
## Working on this repo with an AI agent

This app launches and trades Ascend coins on Elysium (Hyperliquid L2, chain 99901, native HYPE) by talking to the chain
itself. Before changing it:

1. Every chain call goes through `lib/elysium/*`: `chain.ts` (relays, contracts, one public client, the fan-out send),
   `v4.ts` (Universal Router buy/sell calldata, quotes, Permit2 approvals), `ascend.ts` (launchChecked, escrow, fees),
   `desk.ts` (the per-wallet trading contract), `tape.ts` (swap logs), `pin.ts` (IPFS), and `api.ts` (the one client the
   flows use). Add new calls there, one documented function each. Never hard-code a relay in a page or a route.
2. Wallet backup rule: a wallet is written to its JSON file in the wallet folder BEFORE it is used or funded, and nothing
   funds a wallet whose file is missing (`assertBackedUp`). Never weaken this. Desks are recorded in
   `_app/elysium-starter/desks.json` the moment the deploy is sent.
3. Signing happens in this app: `lib/core/evm.ts` signs with viem; every signed transaction is broadcast to every relay
   at once (`lib/elysium/fanout-send.ts`) and the first acceptance wins. Keep it that way: the chain has one sequencer
   and the relays are only doors to it.
4. A sell of what a desk holds is one call with nothing to approve; a wallet-held sell needs ERC20→Permit2 and
   Permit2→router, fired back to back with consecutive nonces the moment the wallet buys. Pre-signed exits
   (`lib/exits.ts`) must stay valid: never change a wallet's nonce behind an armed rule without re-arming.
5. Show chain errors as returned (message, code, hint). Never print secrets, keys, or env values.
