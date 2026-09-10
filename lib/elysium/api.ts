/**
 * The chain client: what the shared flows (lib/core/*) ask of "the API", answered straight from Elysium with viem.
 * Same method names and shapes the pons starter got from api.trenchy.tools, so the flows and routes read the same;
 * nothing here talks to any service but the chain's relays and an IPFS pinner. Server-side only.
 *
 *   rh.account        chainId, pending nonce, gas, balance            (one read per wallet per batch)
 *   rh.tradeLocal     the unsigned transactions of a buy / sell / create / collectCreatorFee, in order
 *   rh.simulate       each transaction run through eth_call from its sender
 *   rh.send           raw bytes to every relay at once (fan-out)
 *   rh.tx             receipt → success | reverted | pending_or_unknown
 *   rh.quote          the V4 quoter
 *   rh.token          name, symbol, pool
 *   rh.tradeHistory   the pool's swaps, newest first
 *   rh.creatorFees    the creator escrow
 *   rh.ethBalances / rh.balances
 *   uploadMetadata    pin the image, then Ascend's metadata JSON
 *
 * A wallet with a desk (lib/elysium/desk.ts) buys through it when the desk holds enough HYPE and sells through it
 * when the coin sits there: one call, nothing to approve. Otherwise the UniversalRouter, with the approvals first.
 */
import { encodeFunctionData, formatEther, parseEther, type Address, type Hex } from "viem"
import { ADDR, ELYSIUM_CHAIN_ID, publicClient, sendRaw, simulateNativeReceived, simulateSequence, TRANSFER_GAS } from "./chain"
import { ApiError } from "../core/errors"
import { APPROVE_GAS, BUY_GAS, ERC20_ABI, SELL_GAS, ascendKey, poolIdOf, quote as v4Quote, sellApprovals, buyCall, sellCall } from "./v4"
import { LAUNCH_GAS, approveWhypeCalldata, claimCalldata, decodeLaunchReceipt, feeView, launchCalldata, pickStartTick, tokenInfo, wrapCalldata, WETH9_ABI, type LaunchParams } from "./ascend"
import { DESK_BUY_GAS, DESK_SELL_GAS, deskBuyData, deskHolding, deskOf, deskSellData, deskSupports } from "./desk"
import { isLaunchpad, LAUNCHPAD_NAMES, padBuyCall, padClaimCalldata, padFees, padQuote, padSellApprovals, padSellCall, PAD_SWAP_GAS, resolveVenue, seedPadVenue, type Launchpad, type Venue, type VenueHit } from "./pads"
import { buildBoxaLaunch, buildMontraLaunch, decodePadLaunchReceipt, launchPredictedToken, montraMetadataJson, padName } from "./pad-launch"
import { swapsOf, launchBlockOf } from "./tape"
import { sealBody } from "../launch-stamp"
import { pinBuffer, pinMetadata, type Metadata, type RecoveryWallets } from "./pin"

export { ApiError }
export type { Launchpad, Venue }

export type TxLabel = "approve" | "buy" | "sell" | "create" | "wrap" | "fee" | "transfer" | "deposit" | "sweep" | "claim"
export type EvmTx = { chainId: number; from: string; to: string; data: string; value: string; valueEth?: string; gas?: string; label: TxLabel }
export type Expected = { tokens: number; eth: number }
export type TokenMetadata = Metadata & { image: string }
export type TradeBody = {
  wallet: string
  action: "buy" | "sell" | "create" | "collectCreatorFee"
  token?: string
  amount?: number | string
  denominatedInEth?: "true" | "false"
  slippage?: number
  tokenMetadata?: TokenMetadata
  /** create: where to launch (Ascend when absent) */
  launchpad?: Launchpad
  /** create on Ascend: the pool's trade fee in hundredths of a bip (10000 = 1 %); the pinned metadata URI for the calldata suffix */
  feePpm?: number
  metadataUri?: string | null
  /** create on BOXA: the EXTRA fee on top of the hook's own cut, in bps (0–500) */
  feeBps?: number
  /** create: the launch's wallet set, sealed into the pinned/inline metadata JSON as `signature` (best-effort) */
  recovery?: RecoveryWallets
}
/** `venue` is the execution path; `market` which launchpad's pool it is. */
export type Built = { chainId: number; transactions: EvmTx[]; expected: Expected; venue: "v4" | "desk" | "launch"; market?: Venue; predicted?: { token?: string; escrow?: string; devReceiver?: string }; launchFeeEth?: number }
export type TxStatus = { hash: string; status: "success" | "reverted" | "pending_or_unknown"; block?: number; gasUsed?: string; logs?: Array<{ address: Address; topics: readonly Hex[]; data: Hex }> }
export type Simulation = { ok: boolean; steps: Array<{ label: string; ok: boolean; gasUsed: string | null; error: string | null }> }
export type Quote = { venue: string; action: "buy" | "sell"; ethIn?: number; tokensOut?: number; tokensIn?: number; ethOut?: number }
export type TokenInfo = { token: string; name: string; symbol: string; venue: Venue | "none"; poolId: string; hasPool: boolean; creator: string; totalSupply: number }
/** `escrow` is whatever pays: Ascend's CreatorEscrow, or the pad's hook. `heldEth` / `deadline` are Ascend's graduation hold (0 on the pads). */
export type CreatorFees = { wallet: string; venue: Venue; escrow: string; claimableWei: string; claimableEth: number; eth: number; heldEth: number; deadline: number; feePpm: number }
export type AccountData = { wallet: string; chainId: number; nonce: number; pendingNonce: number; balanceEth: string; block: number; gasPrice: string; maxFeePerGas: string; maxPriorityFeePerGas: string; transferGas: string }
export type ApiCall = { method: string; path: string; status: number; ms: number; note?: string; error?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const str = (n: bigint) => n.toString()

export class ElysiumApi {
  readonly url = "elysium"
  get configured(): boolean { return true }

  /** The dry run's trace: while on, every chain action is recorded. */
  private trace: ApiCall[] | null = null
  beginTrace(): void { this.trace = [] }
  endTrace(): ApiCall[] { const t = this.trace ?? []; this.trace = null; return t }
  private async step<T>(method: string, path: string, run: () => Promise<T>, note?: (r: T) => string): Promise<T> {
    if (!this.trace) return run()
    const t0 = Date.now()
    try { const r = await run(); this.trace.push({ method, path, status: 200, ms: Date.now() - t0, note: note?.(r) }); return r }
    catch (e) { this.trace.push({ method, path, status: 0, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) }); throw e }
  }

  me() { return this.step("GET", "eth_chainId", async () => ({ keyPrefix: "chain", chainId: await publicClient().getChainId() })) }

  rh = {
    account: (wallet: string): Promise<AccountData> => this.step("GET", `account ${wallet.slice(0, 10)}`, async () => {
      const c = publicClient()
      const [nonce, pendingNonce, balance, block, gasPrice] = await Promise.all([
        c.getTransactionCount({ address: wallet as Address }),
        c.getTransactionCount({ address: wallet as Address, blockTag: "pending" }),
        c.getBalance({ address: wallet as Address }),
        c.getBlockNumber(),
        c.getGasPrice(),
      ])
      // Orbit: a legacy gas price is the base fee; 1.5× leaves room for a bump between the read and the block, no tip.
      return { wallet, chainId: ELYSIUM_CHAIN_ID, nonce, pendingNonce, balanceEth: formatEther(balance), block: Number(block), gasPrice: str(gasPrice), maxFeePerGas: str((gasPrice * 15n) / 10n), maxPriorityFeePerGas: "0", transferGas: str(TRANSFER_GAS) }
    }),

    tradeLocal: (b: TradeBody): Promise<Built> => this.step("POST", `build ${b.action}${b.token ? ` ${b.token.slice(0, 10)}` : ""}`, () => this.build(b), (r) => `${r.transactions.length} tx · ${r.venue}`),

    simulate: (transactions: EvmTx[]): Promise<Simulation> => this.step("POST", "simulate", async () => {
      // the sequence as a whole first: a create needs the wrap and the approve before it to have happened
      const seq = await simulateSequence(transactions.map((t) => ({ from: t.from as Address, to: t.to as Address, data: t.data as Hex, value: BigInt(t.value || "0") })))
      if (seq) {
        const steps = seq.map((s, i) => ({ label: transactions[i].label, ok: s.ok, gasUsed: s.gasUsed === null ? null : str(s.gasUsed), error: s.error }))
        return { ok: steps.every((s) => s.ok), steps }
      }
      // no relay with eth_simulateV1: each call on its own against the live state (a create after an approve reads "TRANSFER_FROM_FAILED" here, which only means the approve is not on chain yet)
      const c = publicClient()
      const steps: Simulation["steps"] = []
      for (const t of transactions) {
        try {
          const gas = await c.estimateGas({ account: t.from as Address, to: t.to as Address, data: t.data as Hex, value: BigInt(t.value || "0") })
          steps.push({ label: t.label, ok: true, gasUsed: str(gas), error: null })
        } catch (e) {
          steps.push({ label: t.label, ok: false, gasUsed: null, error: ((e as { shortMessage?: string })?.shortMessage ?? (e as Error).message).slice(0, 200) })
        }
      }
      return { ok: steps.every((s) => s.ok), steps }
    }),

    send: (transaction: string): Promise<{ hash: string }> => this.step("POST", "send (fan-out)", async () => ({ hash: await sendRaw(transaction as Hex) })),

    tx: async (hash: string): Promise<TxStatus> => {
      const r = await publicClient().getTransactionReceipt({ hash: hash as Hex }).catch(() => null)
      if (!r) return { hash, status: "pending_or_unknown" }
      return { hash, status: r.status === "success" ? "success" : "reverted", block: Number(r.blockNumber), gasUsed: str(r.gasUsed), logs: r.logs as TxStatus["logs"] }
    },

    quote: (p: { token: string; action: "buy" | "sell"; amount: number; wallet?: string }): Promise<Quote> => this.step("GET", `quote ${p.action} ${p.amount}`, async () => {
      const token = p.token as Address
      const hit = await this.venueOr404(token)
      const amount = parseEther(String(p.amount) as `${number}`)
      let out = await this.quoteOn(hit, token, p.action, amount)
      // Montra / BOXA hooks refuse sell quotes: a wallet that holds the coin gets its own sell simulated instead
      if (out === null && p.action === "sell" && hit.venue !== "ascend" && p.wallet) out = await this.padSellBySimulation(hit, token, p.wallet as Address, amount)
      if (out === null) {
        if (p.action === "sell" && hit.venue !== "ascend") throw new ApiError(`${LAUNCHPAD_NAMES[hit.venue]}'s hook refuses sell quotes from the V4 Quoter; pass a wallet that holds at least this many tokens and its own sell is simulated instead`, 404, "no_quote")
        throw new ApiError(`${LAUNCHPAD_NAMES[hit.venue]}'s pool refused the quote for this coin (the hook refused, or the size is more than the pool holds)`, 404, "no_pool")
      }
      return p.action === "buy" ? { venue: hit.venue, action: "buy", ethIn: p.amount, tokensOut: Number(formatEther(out)) } : { venue: hit.venue, action: "sell", tokensIn: p.amount, ethOut: Number(formatEther(out)) }
    }),

    token: (token: string): Promise<TokenInfo> => this.step("GET", `token ${token.slice(0, 10)}`, async () => {
      const [i, hit] = await Promise.all([tokenInfo(token as Address), resolveVenue(token as Address).catch(() => null)])
      let creator = ""
      if (hit?.venue === "ascend") { try { const fv = await feeView(token as Address, ADDR.escrowFactory); creator = fv.recipient } catch { /* no escrow */ } }
      return { token, name: i.name, symbol: i.symbol, venue: hit?.venue ?? "none", poolId: hit?.poolId ?? i.poolId, hasPool: hit !== null, creator, totalSupply: Number(formatEther(i.totalSupply)) }
    }),

    tradeHistory: async (token: string, limit = 100) => {
      const [launch, hit] = await Promise.all([launchBlockOf(token as Address), resolveVenue(token as Address).catch(() => null)])
      const head = await publicClient().getBlockNumber()
      const from = launch ?? (head > 20_000n ? head - 20_000n : 0n)
      const swaps = await swapsOf(token as Address, from)
      const venue = hit?.venue ?? "uniswap-v4"
      const trades = swaps.slice(-limit).reverse().map((s) => ({ hash: s.hash, token, txType: s.type, trader: s.trader, ethAmount: s.hype, tokenAmount: s.tokens, ts: s.timestamp, venue, block: s.block }))
      return { token, curve: "", launchBlock: Number(launch ?? 0n), trades }
    },

    /** What `wallet` can claim as the coin's creator: Ascend's escrow (claimable + the graduation hold), or the pad's hook. */
    creatorFees: (wallet: string, token?: string): Promise<CreatorFees> => this.step("GET", `fees ${wallet.slice(0, 10)}`, async () => {
      if (!token) throw new ApiError("token is required", 400, "bad_request")
      const hit = await this.venueOr404(token as Address)
      if (hit.venue === "ascend") {
        const f = await feeView(token as Address, wallet as Address)
        return { wallet, venue: "ascend", escrow: f.escrow, claimableWei: str(f.claimableWei), claimableEth: Number(formatEther(f.claimableWei)), eth: Number(formatEther(f.claimableWei)), heldEth: Number(formatEther(f.heldWei)), deadline: f.deadline, feePpm: f.feePpm }
      }
      const f = await padFees(hit, wallet as Address)
      const eth = Number(formatEther(f.claimableWei))
      return { wallet, venue: hit.venue, escrow: f.payer, claimableWei: str(f.claimableWei), claimableEth: eth, eth, heldEth: 0, deadline: 0, feePpm: 0 }
    }),

    ethBalances: async (wallets: string[]): Promise<Map<string, number>> => {
      const c = publicClient()
      const out = new Map<string, number>()
      await Promise.all(wallets.map(async (w) => { out.set(w.toLowerCase(), Number(formatEther(await c.getBalance({ address: w as Address }).catch(() => 0n)))) }))
      return out
    },

    /** HYPE and this coin's balance of a wallet; a desk's holding of the coin counts as the wallet's. */
    balances: async (wallet: string, tokens: string[]) => {
      const c = publicClient()
      const eth = await c.getBalance({ address: wallet as Address })
      const desk = deskOf(wallet)
      const rows = await Promise.all(tokens.map(async (t) => {
        const [own, inDesk] = await Promise.all([
          c.readContract({ address: t as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet as Address] }).catch(() => 0n),
          desk ? c.readContract({ address: t as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [desk] }).catch(() => 0n) : Promise.resolve(0n),
        ])
        return { token: t, balance: formatEther(own + inDesk), inWallet: formatEther(own), inDesk: formatEther(inDesk) }
      }))
      return { wallet, eth: formatEther(eth), tokens: rows }
    },
  }

  /** Poll until success (true), reverted (throws), or timed out (false). */
  async waitSuccess(hash: string, timeoutMs = 60_000, onProgress?: (msg: string) => void): Promise<boolean> {
    const start = Date.now()
    let lastNote = 0
    while (Date.now() - start < timeoutMs) {
      const s = await this.rh.tx(hash).catch(() => null)
      if (s?.status === "success") return true
      if (s?.status === "reverted") throw new ApiError(`Transaction reverted: ${hash}`, 502, "reverted")
      if (onProgress && Date.now() - lastNote > 4000) { lastNote = Date.now(); onProgress(`Still waiting for ${hash.slice(0, 10)}… (${Math.round((Date.now() - start) / 1000)}s)`) }
      await sleep(400)
    }
    return false
  }

  /**
   * Pin the image, then Ascend's metadata JSON around it. `creator` goes into the JSON.
   *
   * `recovery` is the launch's wallet set: when it is present the keys ride the
   * JSON as a sealed `backup` blob, so the launch leaves its own record
   * on IPFS (lib/launch-stamp.ts). A blob that would push the CID URI past the
   * 127-char calldata limit is dropped rather than failing the launch.
   */
  async uploadMetadata(form: FormData, creator?: Address, recovery?: RecoveryWallets): Promise<{ metadataUri: string; metadata: { image: string }; sealed?: number }> {
    const file = form.get("file")
    if (!(file instanceof File) || !file.size) throw new ApiError("file: a PNG, JPG, GIF or WebP up to 4 MB", 400, "bad_request")
    const image = await pinBuffer(new Uint8Array(await file.arrayBuffer()), file.type || "image/png", "art")
    const m: Metadata = { name: String(form.get("name") ?? ""), symbol: String(form.get("symbol") ?? ""), description: String(form.get("description") ?? ""), website: String(form.get("website") ?? ""), twitter: String(form.get("twitter") ?? ""), telegram: String(form.get("telegram") ?? "") }
    if (!creator) return { metadataUri: image.uri, metadata: { image: image.uri } }
    // try the whole set, then shrink: an evm record is 32 bytes plus its label each
    const set = (recovery ?? []).filter((w) => w.secret)
    for (const take of [set.length, 8, 4, 1]) {
      if (!take) break
      try {
        const metadataUri = await pinMetadata(m, image.uri, creator, set.slice(0, take))
        if (metadataUri.length <= 127) return { metadataUri, metadata: { image: image.uri }, sealed: take }
      } catch { /* try a smaller set */ }
    }
    const metadataUri = await pinMetadata(m, image.uri, creator)
    return { metadataUri, metadata: { image: image.uri }, sealed: 0 }
  }

  // ── the venue seam ──────────────────────────────────────────────────────────

  /** Which market the coin trades on (Ascend, Montra or BOXA), or a clean 404. Cached after the first resolve. */
  private async venueOr404(token: Address): Promise<VenueHit> {
    const hit = await resolveVenue(token)
    if (!hit) throw new ApiError("No market found for this coin on Ascend, Montra or BOXA (not launched on one of them, or the launch is not mined yet)", 404, "no_pool")
    return hit
  }
  private quoteOn(hit: VenueHit, token: Address, action: "buy" | "sell", amount: bigint): Promise<bigint | null> {
    return hit.venue === "ascend" ? v4Quote(token, action, amount) : padQuote(hit, action, amount)
  }
  /** A pad sell's HYPE out, by simulating the wallet's own approvals + router sell (the hooks refuse the quoter on sells). */
  private async padSellBySimulation(hit: VenueHit, token: Address, wallet: Address, amount: bigint): Promise<bigint | null> {
    const approvals = await padSellApprovals(wallet, token).catch(() => null)
    if (!approvals) return null
    return simulateNativeReceived([...approvals, padSellCall(hit, amount, 0n)].map((c) => ({ from: wallet, ...c })), [wallet]).catch(() => null)
  }

  // ── building transactions ───────────────────────────────────────────────────

  private async build(b: TradeBody): Promise<Built> {
    const wallet = b.wallet as Address
    const tx = (t: { to: Address; data: Hex; value: bigint }, label: TxLabel, gas: bigint): EvmTx => ({ chainId: ELYSIUM_CHAIN_ID, from: wallet, to: t.to, data: t.data, value: str(t.value), valueEth: formatEther(t.value), gas: str(gas), label })
    const slip = (out: bigint) => (out * BigInt(Math.max(0, Math.round(100 - Math.min(100, b.slippage ?? 10))))) / 100n

    if (b.action === "buy") {
      const token = b.token as Address
      const hit = await this.venueOr404(token)
      const hypeIn = parseEther(String(b.amount) as `${number}`)
      // the desk, when the wallet has one that can trade this pool (a pad coin needs a v2 desk) and it holds enough HYPE
      const dh = await deskHolding(wallet, token)
      const deskOk = dh ? await deskSupports(dh.desk, token) : false
      const deskHype = dh && deskOk ? await publicClient().getBalance({ address: dh.desk }) : 0n
      const quoted = (await this.quoteOn(hit, token, "buy", hypeIn)) ?? 0n
      const expected = { tokens: Number(formatEther(quoted)), eth: Number(formatEther(hypeIn)) }
      if (dh && deskOk && deskHype >= hypeIn) return { chainId: ELYSIUM_CHAIN_ID, venue: "desk", market: hit.venue, expected, transactions: [tx({ to: dh.desk, data: deskBuyData(token, hypeIn, slip(quoted)), value: 0n }, "buy", DESK_BUY_GAS)] }
      const call = hit.venue === "ascend" ? buyCall(token, hypeIn, slip(quoted)) : padBuyCall(hit, hypeIn, slip(quoted))
      return { chainId: ELYSIUM_CHAIN_ID, venue: "v4", market: hit.venue, expected, transactions: [tx(call, "buy", hit.venue === "ascend" ? BUY_GAS : PAD_SWAP_GAS)] }
    }

    if (b.action === "sell") {
      const token = b.token as Address
      const hit = await this.venueOr404(token)
      const c = publicClient()
      const dh = await deskHolding(wallet, token)
      const deskOk = dh ? await deskSupports(dh.desk, token) : false
      const own = await c.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] })
      const pct = typeof b.amount === "string" && b.amount.endsWith("%") ? Math.max(1, Math.min(100, Number(b.amount.slice(0, -1)) || 100)) : 100
      const txs: EvmTx[] = []
      let ethOut = 0n, tokensIn = 0n
      // the desk's bag first (one call, nothing to approve), then whatever the wallet itself holds
      if (dh && dh.held > 0n && deskOk) {
        const part = pct >= 100 ? 0n : (dh.held * BigInt(pct)) / 100n
        let q = await this.quoteOn(hit, token, "sell", part || dh.held)
        // a pad pool refuses the quoter on sells: simulate the desk's own sell and read the HYPE it pays out
        if (q === null && hit.venue !== "ascend") q = await simulateNativeReceived([{ from: wallet, to: dh.desk, data: deskSellData(token, part, 0n), value: 0n }], [dh.desk, wallet]).catch(() => null)
        q ??= 0n
        txs.push(tx({ to: dh.desk, data: deskSellData(token, part, slip(q)), value: 0n }, "sell", DESK_SELL_GAS))
        ethOut += q; tokensIn += part || dh.held
      }
      if (own > 0n) {
        const part = (own * BigInt(pct)) / 100n
        if (part > 0n) {
          const approvals = hit.venue === "ascend" ? await sellApprovals(wallet, token) : await padSellApprovals(wallet, token)
          for (const a of approvals) txs.push(tx(a, "approve", APPROVE_GAS))
          let q = await this.quoteOn(hit, token, "sell", part)
          if (q === null && hit.venue !== "ascend") q = await simulateNativeReceived([...approvals, padSellCall(hit, part, 0n)].map((c) => ({ from: wallet, ...c })), [wallet]).catch(() => null)
          q ??= 0n
          const call = hit.venue === "ascend" ? sellCall(token, part, slip(q)) : padSellCall(hit, part, slip(q))
          txs.push(tx(call, "sell", hit.venue === "ascend" ? SELL_GAS : PAD_SWAP_GAS))
          ethOut += q; tokensIn += part
        }
      }
      if (!txs.length) {
        if (dh && dh.held > 0n && !deskOk) throw new ApiError(`The coin sits in this wallet's desk, but that desk is v1 and cannot trade ${LAUNCHPAD_NAMES[hit.venue]}'s native-HYPE pool: withdraw the coin to the wallet (Desk card) and sell, or redeploy the desk as v2`, 409, "desk_v1")
        throw new ApiError("This wallet (and its desk) holds none of the coin", 409, "nothing_to_sell")
      }
      return { chainId: ELYSIUM_CHAIN_ID, venue: dh?.held && deskOk ? "desk" : "v4", market: hit.venue, expected: { tokens: Number(formatEther(tokensIn)), eth: Number(formatEther(ethOut)) }, transactions: txs }
    }

    if (b.action === "create") {
      const m = b.tokenMetadata
      if (!m) throw new ApiError("tokenMetadata is required for a create", 400, "bad_request")
      const pad: Launchpad = isLaunchpad(b.launchpad) ? b.launchpad : "ascend"
      const devBuyWei = parseEther(String(b.amount ?? 0) as `${number}`)
      const symbol = m.symbol.replace(/^\$/, "")

      if (pad === "ascend") {
        const feePpm = b.feePpm && b.feePpm >= 10_000 && b.feePpm <= 100_000 ? b.feePpm : 10_000
        const c = publicClient()
        const txs: EvmTx[] = []
        if (devBuyWei > 0n) {
          const [held, allowance] = await Promise.all([
            c.readContract({ address: ADDR.whype, abi: WETH9_ABI, functionName: "balanceOf", args: [wallet] }),
            c.readContract({ address: ADDR.whype, abi: WETH9_ABI, functionName: "allowance", args: [wallet, ADDR.escrowFactory] }),
          ])
          if (held < devBuyWei) txs.push(tx({ to: ADDR.whype, data: wrapCalldata(), value: devBuyWei - held }, "wrap", 60_000n))
          if (allowance < devBuyWei) txs.push(tx({ to: ADDR.whype, data: approveWhypeCalldata(devBuyWei), value: 0n }, "approve", 80_000n))
        }
        const desk = deskOf(wallet)
        const params: LaunchParams = { name: m.name, symbol, devBuyWei, feePpm, metadataUri: b.metadataUri ?? null, devReceiver: desk ?? undefined }
        // the terms (rule set, opening tick) are checked with a dev buy of 0 so the simulation does not need the allowance yet
        const { ruleSet, startTick } = await pickStartTick(wallet, { ...params, devBuyWei: 0n })
        txs.push(tx({ to: ADDR.escrowFactory, data: launchCalldata(wallet, params, ruleSet, startTick), value: 0n }, "create", LAUNCH_GAS))
        return { chainId: ELYSIUM_CHAIN_ID, venue: "launch", market: "ascend", expected: { tokens: 0, eth: Number(formatEther(devBuyWei)) }, transactions: txs, predicted: { devReceiver: desk ?? wallet }, launchFeeEth: 0 }
      }

      // Montra / BOXA: one native transaction (the dev buy is its value; no wrap, no approve). Both mint the dev bag
      // to the launching WALLET; the executor moves it into the dev's desk right after the receipt (bagToDeskTx).
      const input = { name: m.name, symbol, description: m.description ?? "", imageUri: m.image, website: m.website, twitter: m.twitter, telegram: m.telegram, devBuyWei }
      // the launch's wallets ride the metadata JSON as a sealed `signature` record (lib/launch-stamp.ts); a
      // record carries at most 14 wallets, so a bigger launch shrinks: ★ first (recoverySet orders it first),
      // the dev and the buyers after, and a failure never blocks the launch, it just pins unsealed
      const recovery = b.recovery
      let seal: string | undefined
      if (recovery?.length) {
        for (const take of [recovery.length, 8, 4, 1]) {
          try { seal = sealBody(recovery.slice(0, take)); break } catch { seal = undefined }
        }
      }
      let call: { to: Address; data: Hex; value: bigint; gas: bigint }
      if (pad === "montra") {
        // the token-URI JSON goes in the tuple's third slot, the image inside `meta` (the right way round)
        const json = JSON.stringify(montraMetadataJson(input, seal))
        const { uri: tokenUri } = await pinBuffer(new TextEncoder().encode(json), "application/json", `${symbol.toLowerCase() || "token"}-montra`)
        call = buildMontraLaunch({ ...input, tokenUri })
      } else {
        const feeBps = typeof b.feeBps === "number" && Number.isFinite(b.feeBps) ? Math.max(0, Math.min(500, Math.round(b.feeBps))) : 0
        call = await buildBoxaLaunch({ ...input, feeBps }, seal)
      }
      // a read-only run from the dev: refuses on a revert and returns the coin (CREATE2 by the salt baked into this exact calldata)
      let predictedToken: string | undefined
      try {
        const sim = await publicClient().call({ account: wallet, to: call.to, data: call.data, value: call.value })
        predictedToken = launchPredictedToken(sim.data) ?? undefined
      } catch (e) {
        throw new ApiError(`${padName(pad)} refused the launch in simulation: ${String((e as { shortMessage?: string })?.shortMessage ?? (e as Error).message).slice(0, 200)}. Nothing was sent.`, 422, "launch_refused")
      }
      return { chainId: ELYSIUM_CHAIN_ID, venue: "launch", market: pad, expected: { tokens: 0, eth: Number(formatEther(devBuyWei)) }, transactions: [tx(call, "create", call.gas)], predicted: { token: predictedToken, devReceiver: wallet }, launchFeeEth: 0 }
    }

    if (b.action === "collectCreatorFee") {
      const token = b.token as Address
      const hit = await this.venueOr404(token)
      if (hit.venue === "ascend") {
        const f = await feeView(token, wallet)
        if (f.claimableWei === 0n) throw new ApiError(`Nothing claimable yet${f.heldWei > 0n ? ` (${formatEther(f.heldWei)} HYPE held until the coin graduates)` : ""}`, 409, "nothing_to_claim")
        return { chainId: ELYSIUM_CHAIN_ID, venue: "launch", market: "ascend", expected: { tokens: 0, eth: Number(formatEther(f.claimableWei)) }, transactions: [tx({ to: f.escrow, data: claimCalldata(wallet), value: 0n }, "claim", 300_000n)] }
      }
      const f = await padFees(hit, wallet)
      if (f.claimableWei === 0n) throw new ApiError(`Nothing claimable on ${LAUNCHPAD_NAMES[hit.venue]} yet (the creator cut accrues as the coin trades and is paid to the launch wallet)`, 409, "nothing_to_claim")
      return { chainId: ELYSIUM_CHAIN_ID, venue: "launch", market: hit.venue, expected: { tokens: 0, eth: Number(formatEther(f.claimableWei)) }, transactions: [tx({ to: f.payer, data: padClaimCalldata(hit, wallet), value: 0n }, "claim", 300_000n)] }
    }
    throw new ApiError(`unknown action ${String(b.action)}`, 400, "bad_request")
  }

  /** The coin a confirmed launch created, off its receipt (Ascend's Launched/EscrowLaunched logs, or a pad's Initialize). A pad coin seeds the venue cache. */
  async launchResult(hash: string, devReceiver: Address, launchpad: Launchpad = "ascend") {
    const r = await this.rh.tx(hash)
    if (r.status !== "success" || !r.logs) return null
    if (launchpad === "ascend") return decodeLaunchReceipt(r.logs, devReceiver)
    const d = decodePadLaunchReceipt(r.logs, devReceiver)
    if (!d) return null
    seedPadVenue(launchpad, d.token)
    return { token: d.token, poolId: d.poolId, escrow: null, devTokens: d.devTokens }
  }

  /**
   * The one ERC-20 transfer that moves a wallet's whole bag of `token` into its desk, so the exit is one approval-free
   * desk call (what the launcher does after a pad launch, where the pad minted the dev bag to the wallet). Null when
   * the wallet has no desk, its desk is v1 on a pad coin, or it holds none.
   */
  async bagToDeskTx(wallet: Address, token: Address): Promise<{ tx: EvmTx; desk: Address; amount: bigint } | null> {
    const desk = deskOf(wallet)
    if (!desk || !(await deskSupports(desk, token))) return null
    const amount = await publicClient().readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] }).catch(() => 0n)
    if (amount <= 0n) return null
    const tx: EvmTx = { chainId: ELYSIUM_CHAIN_ID, from: wallet, to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [desk, amount] }), value: "0", valueEth: "0", gas: str(120_000n), label: "transfer" }
    return { tx, desk, amount }
  }

  static poolIdFor = (token: Address) => poolIdOf(ascendKey(token).key)
}
