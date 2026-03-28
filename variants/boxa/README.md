<!-- trenchytools:header -->
<p align="center"><img src="./.github/social.png" alt="elysium starter" width="100%"></p>

<p align="center"><a href="https://boxa.trenchy.tools">Live demo</a> · <a href="https://trenchy.tools/docs">Docs</a> · <a href="https://github.com/Trenchy-Tools">All starters</a> · <a href="https://boxa.club">BOXA</a> · <a href="https://elyscan.io">Elyscan</a></p>

# elysium starter · BOXA edition

A launch and trading tool for **BOXA** ([boxa.club](https://boxa.club)) on **Elysium** (Kinetiq's Hyperliquid
L2, chain id 99901, native HYPE). One Next.js app, one process, one `npm run dev`. It makes the coin the way BOXA's own
site does, with **your own creator fee of 0–5 %** on top of the hook's cut, buys it with your bundle wallets in the next
blocks, and sells it on rules you set before anyone else arrives.

**One codebase, three launchpads.** This is the BOXA edition: the Launch page opens on BOXA. The same app also
launches on **Ascend** and **Montra**, and trades coins from all three. The sibling repositories are the same code opened on
the other pads: [Ascend](https://github.com/Trenchy-Tools/trenchytools-elysium-launcher),
[Montra](https://github.com/Trenchy-Tools/trenchytools-montra-launcher),
[BOXA](https://github.com/Trenchy-Tools/trenchytools-boxa-launcher).

> ### Pre-mainnet build
> Elysium has no official public RPC until its public mainnet launch, so this build **talks to the chain itself over
> a rotating set of community relays** (Agoradex, Volta, Kleos, ElysPump): reads run over the fastest ones, every
> signed transaction is broadcast to all of them at once and the first acceptance wins. There is no API key, no
> account and nothing in the middle. **At the public mainnet launch the same app moves onto the
> [TrenchyTools API](https://trenchy.tools/docs)**, which already builds and simulates BOXA launches and trades,
> and the relay list becomes a fallback. Everything else in this README stays the same.

## What each feature talks to

| Feature | Today (pre-mainnet) | At the mainnet launch |
| --- | --- | --- |
| Launch (one checked call, the dev buy as its value) | BOXA's launcher `0x5da7…03ed` on chain via the relays | `POST /api/elysium/create { venue: "boxa" }` |
| Image | IPFS (QuickNode or Pinata key in `.env`); the metadata rides the call as inline JSON | `POST /api/ipfs` |
| Buys and sells | Universal Router on the coin's native-HYPE pool, or the wallet's desk | `POST /api/elysium/trade-local` |
| Dry run | `eth_call` + `eth_simulateV1` over the relays | the same |
| Live trades, outside-flow gates, auto-sell triggers | the pool's `Swap` logs, polled every 600 ms | the same |
| Creator fees | the hook's `claimable(token, creator)` / `claim(token, to)` | `POST /api/elysium/collect-fees` |

## What it is

- **Wallets**: one list, each wallet a file in `./wallets`. **+ New wallet** (× N) or **Import ▾** a 0x key; the first
  one becomes ★, the main wallet that pays for everything and receives gathers (click ☆ to move it). Per row **Fund**
  (from ★) and **Key**; tick rows for **Amount each · Fund from ★ · Gather to ★ · Send ▾ · Export keys · Archive**.
  Every send is direct, wallet to wallet, through every relay at once.
- **Launch**: pick the launchpad (BOXA first), then name, symbol, image, socials, the **creator fee** (BOXA's extra fee on buys and sells, 0–5 %, paid to you), the dev buy, the
  **auto-sell** armed the moment the coin exists, how many **bundle buyers** and **holder wallets** buy with it. A dry
  run simulates the launch and names the coin; the launch shows a live log of every hash and opens the Trading page
  on the coin.
- **Trading**: **Buy all / Sell all** across the fleet (stagger, skip dev), then every wallet in a row with
  **[amount] Buy** and **25 / 50 / 100 %** sell buttons; tick rows to act across the selection or add a timed sell;
  the coin's trades on the right from the chain's own swap logs, 600 ms apart. Paste any coin from Ascend, Montra or
  BOXA: the app finds its pool by itself. The **Desk** card and the **Auto-sell** card sit above **Creator fees**.

The app holds your keys and signs locally with [viem](https://viem.sh). Reads go over the fastest community relays;
every signed transaction is broadcast to **all** of them at once and the first acceptance wins (the chain has one
sequencer, the relays are only doors to it). No database, no login, no encryption layer: a local, single-user tool.

## 5-minute start

```bash
git clone https://github.com/Trenchy-Tools/trenchytools-boxa-launcher && cd trenchytools-boxa-launcher
npm install
cp .env.example .env     # relays (optional), an IPFS pinning key (QuickNode or Pinata) for the coin's image
npm run dev
```

Open http://localhost:3000. The status dot in the top bar says whether the relays answer and whether a ★ wallet
exists; click it for Settings. On **Wallets**, press **+ New wallet** (it becomes ★) and send it some HYPE on Elysium
(MetaMask: chain id 99901, RPC `https://rpc.agoradex.app`, symbol HYPE). Start with small sizes and press **Dry run**
before the first launch: it runs the launch through `eth_call` on the live chain and shows the coin's address.

## Where your keys are

Every wallet is a JSON file in one folder:

| Setting                   | Folder                                      |
| ------------------------- | ------------------------------------------- |
| `WALLET_BACKUP_DIR` set   | that folder                                 |
| otherwise                 | `./wallets` (inside the clone, git-ignored) |

Files are named `<date>-ely-<role>-<0xaddress>.json` and hold
`{ publicKey, privateKey, chain: "ely", role, label, createdAt, app, note }`; every wallet is also one line in
`wallets.csv`. The folder can be shared with the other starters (they write `chain: "sol"` / `"rh"` files); this app
lists only `chain: "ely"`. Its own state (settings incl. the ★ wallet, launch records, desks, armed exits) sits in
`_app/elysium-starter/`; archived wallets' files move to `archived/` (keys kept, never used).

The folder **is** the store. The app writes a file **before** a create or import returns, and refuses to fund, launch
with, trade with or gather from any wallet whose file is missing (HTTP 409 `not_backed_up`). Back the folder up like
you would a seed phrase: anyone with a file controls that wallet.

## How a launch works on BOXA

BOXA launches every coin into a Uniswap v4 pool against **native HYPE** on the main PoolManager:
`(HYPE, coin, fee 0, tick spacing 200, hook 0x10f1…2aec)` (coins from before 2026-11-05 sit behind the first hook,
`0x00c0…2acc`, with the same key shape; the app tries both). The app does what the site does, minus the site:

1. **The image is pinned first**, then the coin's metadata rides the launch call itself as a JSON string: the image
   as an https link (an IPFS gateway URL), the description and the links you set.
2. **One checked call.** `launcher.launch(params)` with the dev buy as `value`. BOXA refuses a launch whose
   `expectedExtraCutBps` is not the hook's current `extraCutBps()` (read live right before building) or whose opening
   tick is not its own (166200). `creatorBps` is 10000: the whole creator side is yours.
3. **Your creator fee.** BOXA's extra fee on buys and sells, in pips on top of the hook's own cut: 0 % is what BOXA's
   site sends (and earns the creator nothing), 1–2 % is the usual pick, up to 5 % is accepted, 10 % is refused. It is
   fixed at launch and accrues in the hook for the creator.
4. **Simulated, then signed.** The call is run from the dev wallet right before signing; the simulation returns the
   coin's address, so the log names the coin before it exists.
5. **The buys go out the moment the launch confirms**, each bundle wallet with its own nonce, fanned out to every
   relay, through the Universal Router on the native pool (or the wallet's desk). Wallet-held buyers get their two
   Permit2 approvals right after. **The dev bag moves into the dev's desk** (when it has a v2 one) with one transfer,
   and **the auto-sell is armed**: a sell pre-signed for every wallet that holds the coin, fired on the first trigger.

**Cost**: per buy, HYPE + a 0.002 HYPE gas reserve; the launch is ~1.6M gas (1.9M limit) at the chain's 0.1–0.3 gwei.
BOXA charges no creation fee. Optional: BOXA's own relay (`https://rpc-live.boxa.club`) can be added to
`ELYSIUM_RPC_URLS` as one more door for sends.

Checked on 2026-11-06 against the live chain over the public relays, by simulation: a launch with a 1 % creator fee, a
bundle buy on the new coin, both approvals and a sell, in one sequence (`eth_simulateV1`), plus buy → approve → sell on
a live BOXA coin.

## Buying with other wallets: bundle or stagger

- **Bundle buyers** buy the instant the launch confirms (up to 16), each with its own nonce, fanned out to every relay.
  No gate: they are part of the launch.
- **Staggered buyers** buy one at a time after the launch under rules you set on the form: first buy after N s, a
  random gap between buys, and a **gate on outsiders' net buying** over the last window (their buys minus their
  sells; our own wallets and desks never count). Below the floor means nobody is here yet, above the cap means bots
  are piling in; either way the wallet waits and re-checks every 2 s, and is skipped after its give-up time. The run
  stops the moment one of our wallets sells. Every verdict is written to the launch log.

## Auto-sell: optional, per wallet

The **Auto-sell** switch arms, the moment the coin exists, a sell pre-signed for every wallet that holds it. Two
"sell everything" rules (both optional): `$` net outside in, or the next outside buy of at least N HYPE. On top, every
wallet, the dev included, can carry its own bar: **sells @ outside HYPE in ≥ X**, where *outside HYPE in* is the HYPE
strangers have net-put into the coin since launch. S1 at 1, S2 at 3, dev at 8 means S1's pre-signed sell goes out the
moment outsiders have net-bought 1 HYPE, S2 keeps holding until 3, the dev until 8; the "sell everything" rules fire
whatever is still held. Armed rules persist in `_app/elysium-starter/exits.json` and resume with the server.

## Desks (advanced, optional)

Elysium's Universal Router needs two approvals before a wallet can sell. This app fires them right after every buy,
so by exit time a plain sell is one transaction. A **desk** is one small contract a wallet owns
([`contracts/ElysiumDesk.sol`](contracts/ElysiumDesk.sol)) that holds HYPE and trades straight against the PoolManager
with nothing to approve. BOXA coins trade in native-HYPE pools, which need a **v2 desk** (every desk deployed by this
version is v2; the Desk card offers **Redeploy as v2** for an older one). BOXA mints the dev bag to the launching
wallet, so when the dev wallet has a v2 desk the app moves the bag into it with one transfer right after the launch
confirms: from then on the dev's exit is one approval-free call. It sits under **Advanced** on the Trading page.

## Trading, exits and fees

Pick one of your launches or paste a token. Every wallet is a row with its HYPE, its tokens (desk holdings folded in)
and their value, then **Buy** and **25 / 50 / 100 %** sell buttons. BOXA pools quote native HYPE, so a buy sends HYPE
straight through the Universal Router (no wrap) and a wallet-held sell sends its two Permit2 approvals first
(consecutive nonces) and the sell right behind. **Live trades** come from the PoolManager's Swap logs for the coin's
pool, polled every 600 ms (the chain's blocks are 160 ms apart; no public websocket yet).

**Auto-sell** (the card on the right, or the launch form): the two "sell everything" rules, `incl. dev` or `no dev`,
and a per-wallet bar on outside HYPE in under *per-wallet bars*. **Sell now** fires the pre-signed set by hand.

**Creator fees** read what BOXA's hook holds for the creator (`claimable(token, creator)`, on whichever of the two hooks the coin's pool uses). **Claim** sends it from the creator wallet (the wallet that launched). The HYPE price for the
dollar bars comes from Hyperliquid's own `allMids`.

## The files to copy

[`lib/elysium/`](lib/elysium) is the whole chain layer: `chain.ts` (relays, contracts, fan-out send), `pads.ts`
(Montra's and BOXA's addresses, pool keys, venue detection, swaps, creator fees), `pad-launch.ts` (both launch calls,
byte for byte the way the pads' own sites send them, and the receipt decoder), `v4.ts` (router calldata, quotes,
approvals), `ascend.ts`, `desk.ts`, `tape.ts`, `pin.ts`, and [`api.ts`](lib/elysium/api.ts), the one client the flows
use. [`lib/brand.ts`](lib/brand.ts) is the one line that makes this copy the BOXA edition.
[`lib/core/evm.ts`](lib/core/evm.ts) is the signer with its nonce run, [`lib/exits.ts`](lib/exits.ts) the pre-signed
exits, [`lib/wallets.ts`](lib/wallets.ts) the folder store with the backup rule.

## Host it

```bash
docker build -t boxa-starter .
docker run -p 3000:3000 -v boxa-wallets:/data -e QUICKNODE_API_KEY=… boxa-starter
```

`WALLET_BACKUP_DIR` is `/data/wallets`; mount a volume at `/data` or the wallet files vanish with the container. The
app has no login: put it behind something that does before exposing it beyond localhost (local mode signs and sends
from the server, and armed exits live there).

### Hosted demo mode

The live demo at [boxa.trenchy.tools](https://boxa.trenchy.tools) is this app built in **demo mode**: every wallet key lives in the
visitor's browser (localStorage, with a backup download before anything can be funded), launches, the auto-sell and timed
sells run in the open tab, and every chain call goes from the tab straight to the public relays. The container holds no
wallet and serves no wallet route (every `/api/*` answers 404 `demo_mode`). IPFS pins go to the TrenchyTools API with a
key made for each visitor. To host your own:

```bash
docker build --build-arg NEXT_PUBLIC_DEMO=1 --build-arg NEXT_PUBLIC_LAUNCHPAD=boxa -t boxa-demo .
docker run -p 3000:3000 -e DEMO_MODE=1 boxa-demo
```

MIT licensed.
