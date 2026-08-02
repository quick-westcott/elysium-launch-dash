/**
 * The launch executor for Ascend, Montra and BOXA. One launch transaction (on Ascend: wrap + approve ahead of it when
 * there is a dev buy), then buys in three groups. Run by the server on the wallet folder (lib/launch.ts). Every
 * function takes the Env first.
 *
 *   1. api.rh.tradeLocal { action: "create", launchpad } → [wrap?] [approve?] create. The dev buy happens INSIDE the
 *      launch. On Ascend the dev bag lands in the dev wallet's desk when it has one; Montra and BOXA mint it to the
 *      wallet, so right after the receipt it is moved into the desk (one transfer) — the exit is then one call.
 *   2. Sign in order with the dev wallet, fan-out each; wait for the create; read the coin off its receipt.
 *   3. The moment it is live: every bundle wallet's buy at once (fire-and-forget through the fan-out, so they land
 *      in the next blocks). Snipers staggered `sniperGapMs`. The staggered buyers (`holders`) go one after another
 *      under `stagger` rules: a start delay, a random gap, and a GATE on outsiders' net buying over a window (below
 *      the floor or above the cap = do not buy; wait and re-check until the wallet's give-up time), plus "stop the
 *      run if any of our wallets sells". Without rules they are spread over `holderWindowS` after `holderDelayS`.
 *   4. The auto-sell (lib/exits.ts) is armed by the route the moment the coin exists, when the form asks for it.
 */
import { AppError } from "./errors"
import { fundDirect, type FundResult } from "./funding"
import { where, type Env as BaseEnv } from "./env"
import { sendAll, waitSuccess } from "./evm"
import { padToken, txLink } from "../links"
import { isLaunchpad, LAUNCHPAD_NAMES, type Launchpad } from "../chain"
import type { Built, EvmTx, Simulation, TokenMetadata } from "../elysium/api"
import { CHAIN, type WalletInfo } from "./wallet-record"
import type { RecoveryWallets } from "../elysium/pin"

export const API_FEE_PCT = 0           // no API fee: this app talks to the chain itself
export const GAS_RESERVE_ETH = 0.002   // a launch is ~5.2M gas (Ascend) / ~1.4–1.9M (Montra, BOXA), a buy ~0.6M, at 0.1–0.3 gwei
export const LAUNCH_FEE_ETH = 0        // none of the three charges a creation fee
export const MAX_BUNDLE = 16

/** `sellAtHypeIn`: this wallet's own auto-sell bar, outside HYPE in (their buys − their sells since launch); 0/absent = none */
export type Buyer = { publicKey: string | null; amount: number; sellAtHypeIn?: number }
/**
 * The staggered buyers' rules. `minOutsideHype` / `maxOutsideHype` bound outsiders' NET buying (buys − sells by
 * wallets that are not ours) over the last `windowS` seconds; 0 = no floor / no cap. A wallet waits while the number
 * is outside the range, re-checking every 2 s, and is skipped after `giveUpS`. `stopOnOwnSell` ends the whole run the
 * moment the tape shows a sell by one of our wallets (the auto-sell fired, or a sell by hand).
 */
export type StaggerRules = { startDelayS: number; gapMinS: number; gapMaxS: number; windowS: number; minOutsideHype: number; maxOutsideHype: number; giveUpS: number; stopOnOwnSell: boolean }
export const STAGGER_DEFAULTS: StaggerRules = { startDelayS: 5, gapMinS: 8, gapMaxS: 25, windowS: 60, minOutsideHype: 0.5, maxOutsideHype: 20, giveUpS: 600, stopOnOwnSell: true }
export type BuyerGroup = { count: number; eth: number; wallets?: Buyer[] }
export type LaunchForm = {
  name: string; symbol: string; description?: string; image: string; twitter?: string; telegram?: string; website?: string
  /** where to launch; Ascend when empty */
  launchpad?: Launchpad
  /** the pinned Ascend metadata JSON for the calldata suffix (POST /api/launch/image answers it) */
  metadataUri?: string
  /** the creator; the ★ wallet when empty */
  devWallet?: string
  devBuyEth: number
  /** Ascend: the pool's trade fee, hundredths of a bip (10000 = 1 %, up to 100000); Settings' figure when empty */
  feePpm?: number
  /** BOXA: the EXTRA fee on top of the hook's own cut, in bps (0–500); 0 when empty */
  feeBps?: number
  bundle: BuyerGroup; snipers: BuyerGroup; holders: BuyerGroup
  /** the staggered buyers' (holders') rules; absent = spread over Settings' holder window */
  stagger?: StaggerRules
  slippage?: number
  fundFirst?: boolean
  /** arm the auto-sell on the coin the moment it exists (absent = no auto-sell); the rules may both be 0 when only per-wallet bars are set */
  exit?: { usd?: number; nextBuyHype?: number; scope?: "all" | "noDev" }
  /** the dev wallet's own bar on outside HYPE in */
  devSellAtHypeIn?: number
}

export type Picked = WalletInfo & { amount: number; sellAtHypeIn?: number }
export type Resolved = { dev: WalletInfo; bundle: Picked[]; snipers: Picked[]; holders: Picked[]; exempt: string[]; warnings: string[] }

export type LogEntry = { t: number; stage: string; msg: string; hash?: string; link?: string; token?: string; level?: "info" | "ok" | "warn" | "error"; done?: boolean }
export type LaunchRecord = {
  id: string; createdAt: string; status: "running" | "done" | "failed"; name: string; symbol: string; image: string
  launchpad?: Launchpad
  token?: string; curve?: string; escrow?: string; devReceiver?: string; dev: string; wallets: { bundle: string[]; snipers: string[]; holders: string[] }
  hashes: { create?: string; buys: Array<{ publicKey: string; role: string; hash?: string; error?: string }> }
  links?: { pons: string; blockscout?: string }
  error?: string
}
export type Env = BaseEnv<LaunchRecord>
export type Log = (stage: string, msg: string, extra?: Partial<LogEntry>) => void

const isAddr = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)
const group = (g: Partial<BuyerGroup> | undefined, max = 500): BuyerGroup => {
  const wallets: Buyer[] = []
  if (Array.isArray(g?.wallets)) {
    for (const x of g.wallets as Array<Partial<Buyer>>) {
      const amount = Math.max(Number(x?.amount) || 0, 0)
      const sellAtHypeIn = Number(x?.sellAtHypeIn) > 0 ? Number(x!.sellAtHypeIn) : undefined
      if (!x?.publicKey) { wallets.push({ publicKey: null, amount, sellAtHypeIn }); continue }
      if (!isAddr(x.publicKey) || wallets.some((b) => b.publicKey?.toLowerCase() === x.publicKey!.toLowerCase())) continue
      wallets.push({ publicKey: x.publicKey, amount, sellAtHypeIn })
    }
  }
  if (wallets.length > max) throw new AppError(`at most ${max} wallets in this group`, "bad_request", 400)
  return { count: wallets.length || Math.min(Math.max(Math.floor(Number(g?.count) || 0), 0), max), eth: Math.max(Number(g?.eth) || 0, 0), ...(wallets.length ? { wallets } : {}) }
}
export const groupSize = (g: BuyerGroup): number => g.wallets?.length ?? g.count

/** Validate the form and fill the defaults. */
export function normalizeForm(f: Partial<LaunchForm>): LaunchForm {
  const name = String(f.name ?? "").trim(), symbol = String(f.symbol ?? "").trim(), image = String(f.image ?? "").trim()
  if (!name || !symbol) throw new AppError("name and symbol are required", "bad_request", 400)
  if (!/^(https?:\/\/|ipfs:\/\/)/.test(image)) throw new AppError("image must be an https:// or ipfs:// link: upload one first (POST /api/launch/image)", "bad_request", 400)
  const devBuyEth = Math.max(Number(f.devBuyEth) || 0, 0)
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
  const launchpad: Launchpad = isLaunchpad(f.launchpad) ? f.launchpad : "ascend"
  const feePpm = launchpad === "ascend" ? Number(f.feePpm) || undefined : undefined
  if (feePpm !== undefined && (feePpm < 10_000 || feePpm > 100_000)) throw new AppError("feePpm must be between 10000 (1 %) and 100000 (10 %)", "bad_request", 400)
  const feeBps = launchpad === "boxa" ? Math.round(Number(f.feeBps) || 0) : undefined
  if (feeBps !== undefined && (feeBps < 0 || feeBps > 500)) throw new AppError("feeBps (BOXA's extra fee) must be between 0 and 500 (5 %)", "bad_request", 400)
  const num = (v: unknown, d: number, lo = 0) => { const x = Number(v); return Number.isFinite(x) && String(v).trim() !== "" ? Math.max(x, lo) : d }
  const st = f.stagger as Partial<StaggerRules> | undefined
  const stagger: StaggerRules | undefined = st ? (() => {
    const gapMinS = num(st.gapMinS, STAGGER_DEFAULTS.gapMinS)
    const minOutsideHype = num(st.minOutsideHype, 0), maxOutsideHype = num(st.maxOutsideHype, 0)
    if (maxOutsideHype > 0 && maxOutsideHype < minOutsideHype) throw new AppError("stagger: the outside-flow cap must be at least the floor", "bad_request", 400)
    return { startDelayS: num(st.startDelayS, STAGGER_DEFAULTS.startDelayS), gapMinS, gapMaxS: Math.max(num(st.gapMaxS, STAGGER_DEFAULTS.gapMaxS), gapMinS), windowS: num(st.windowS, STAGGER_DEFAULTS.windowS, 5), minOutsideHype, maxOutsideHype, giveUpS: num(st.giveUpS, STAGGER_DEFAULTS.giveUpS, 10), stopOnOwnSell: st.stopOnOwnSell !== false }
  })() : undefined
  // the auto-sell is optional: `exit` present = on (its two rules may both be 0 when only per-wallet bars are set)
  const exit = f.exit && typeof f.exit === "object"
    ? { usd: Math.max(Number(f.exit.usd) || 0, 0), nextBuyHype: Math.max(Number(f.exit.nextBuyHype) || 0, 0), scope: f.exit.scope === "noDev" ? "noDev" as const : "all" as const }
    : undefined
  const devSellAtHypeIn = Number(f.devSellAtHypeIn) > 0 ? Number(f.devSellAtHypeIn) : undefined
  return { name, symbol, image, launchpad, metadataUri: str(f.metadataUri), description: str(f.description), twitter: str(f.twitter), telegram: str(f.telegram), website: str(f.website), devWallet: str(f.devWallet), devBuyEth, feePpm, feeBps, stagger, devSellAtHypeIn, bundle: group(f.bundle, MAX_BUNDLE), snipers: group(f.snipers), holders: group(f.holders), slippage: Number(f.slippage) || undefined, fundFirst: f.fundFirst !== false, exit }
}

/** The create body for the chain client: the launchpad, the fee field it takes, and the resolved wallet set
 *  (its keys ride the pinned/inline metadata as a sealed recovery record, best-effort). */
const recoveryLabel = (env: Env, f: LaunchForm, k: { publicKey: string; privateKey: string; label: string }) => {
  const addr = k.publicKey.toLowerCase()
  const star = env.wallets.main()?.publicKey?.toLowerCase()
  const dev = f.devWallet?.toLowerCase() || star
  if (addr && addr === star) return addr === dev ? `Dev/Funder - ${f.symbol}` : `Funder - ${f.symbol}`
  if (addr && addr === dev) return `Dev - ${f.symbol}`
  return k.label
}
/** The launch's wallet set for the seal: ★ (it funds the buyers), the dev, and every buyer, keys included. */
function recoverySet(env: Env, f: LaunchForm, r: Resolved): RecoveryWallets {
  const star = env.wallets.main()
  const addrs = [...new Set([star?.publicKey, r.dev.publicKey, ...r.bundle.map((w) => w.publicKey), ...r.snipers.map((w) => w.publicKey), ...r.holders.map((w) => w.publicKey)].filter(Boolean) as string[])]
  try { return env.wallets.secrets(addrs).map((k) => ({ publicKey: k.publicKey, secret: k.privateKey, label: recoveryLabel(env, f, k) })) } catch { return [] }
}
const createBody = (env: Env, f: LaunchForm, wallet: string, recovery?: RecoveryWallets) => ({
  wallet, action: "create" as const, tokenMetadata: metadataOf(f), amount: f.devBuyEth, slippage: f.slippage ?? env.slippage,
  launchpad: f.launchpad ?? "ascend", feePpm: f.launchpad === "boxa" || f.launchpad === "montra" ? undefined : f.feePpm ?? env.feePpm, metadataUri: f.metadataUri ?? null, feeBps: f.feeBps,
  ...(recovery?.length ? { recovery } : {}),
})
const feeText = (env: Env, f: LaunchForm) => (f.launchpad === "montra" ? "trade fee: the hook's default" : f.launchpad === "boxa" ? `extra fee ${((f.feeBps ?? 0) / 100).toFixed(0)} % on top of the hook's` : `trade fee ${((f.feePpm ?? env.feePpm) / 10_000).toFixed(0)} %`)

export function materialize(env: Env, f: LaunchForm): LaunchForm {
  const fill = (g: BuyerGroup, role: "bundle" | "sniper" | "holder"): BuyerGroup => {
    if (!g.wallets?.some((b) => !b.publicKey)) return g
    const fresh = env.wallets.create(g.wallets.filter((b) => !b.publicKey).length, role, role)
    return { ...g, wallets: g.wallets.map((b) => ({ publicKey: b.publicKey ?? fresh.shift()!.publicKey, amount: b.amount, sellAtHypeIn: b.sellAtHypeIn })) }
  }
  return { ...f, bundle: fill(f.bundle, "bundle"), snipers: fill(f.snipers, "sniper"), holders: fill(f.holders, "holder") }
}

const placeholder = (role: "bundle" | "sniper" | "holder", i: number): WalletInfo => ({ publicKey: "", chain: CHAIN, role, label: `${role} ${i + 1} (new)`, createdAt: "", app: "", file: "" })

export const metadataOf = (f: LaunchForm): TokenMetadata => ({ name: f.name, symbol: f.symbol, image: f.image, description: f.description, twitter: f.twitter, telegram: f.telegram, website: f.website })

function pickOrCreate(env: Env, role: "bundle" | "sniper" | "holder", count: number, label: string): WalletInfo[] {
  const have = env.wallets.list(role)
  if (have.length >= count) return have.slice(0, count)
  return [...have, ...env.wallets.create(count - have.length, role, label)]
}

function pick(env: Env, role: "bundle" | "sniper" | "holder", g: BuyerGroup): Picked[] {
  if (g.wallets?.length) {
    return g.wallets.map((b, i) => {
      if (!b.publicKey) return { ...placeholder(role, i), amount: b.amount, sellAtHypeIn: b.sellAtHypeIn }
      const w = env.wallets.get(b.publicKey)
      if (!w) throw new AppError(`No wallet ${b.publicKey} ${where(env.wallets)} (archived, or never created here)`, "not_backed_up", 409, "Pick wallets from the list on the Launch page")
      return { ...w, amount: b.amount, sellAtHypeIn: b.sellAtHypeIn }
    })
  }
  return pickOrCreate(env, role, g.count, role).map((w) => ({ ...w, amount: g.eth }))
}

const amounts = (ws: Picked[]): string => {
  const xs = ws.map((w) => w.amount)
  const lo = Math.min(...xs), hi = Math.max(...xs)
  return lo === hi ? `${lo} HYPE each` : `${lo}–${hi} HYPE`
}

export function resolveWallets(env: Env, f: LaunchForm): Resolved {
  const dev = f.devWallet ? env.wallets.get(f.devWallet) : env.wallets.main()
  if (!dev) throw new AppError(f.devWallet ? `No wallet ${f.devWallet} ${where(env.wallets)}` : "No ★ wallet yet: create or import one on the Wallets page", "no_funding_wallet", 400)
  return { dev, bundle: pick(env, "bundle", f.bundle), snipers: pick(env, "sniper", f.snipers), holders: pick(env, "holder", f.holders), exempt: [], warnings: [] }
}

export type PlanRow = { publicKey: string; label: string; role: string; buyEth: number; needEth: number; haveEth?: number; shortEth?: number }
export type Plan = { rows: PlanRow[]; totalEth: number; shortEth?: number; warnings: string[] }

/** Per buy: HYPE + a gas reserve; the dev's launch is ~5.2M gas. */
export function fundingPlan(f: LaunchForm, r: Resolved): Plan {
  const need = (eth: number) => eth + GAS_RESERVE_ETH
  const rows: PlanRow[] = [{ publicKey: r.dev.publicKey, label: r.dev.label, role: "dev", buyEth: f.devBuyEth, needEth: need(f.devBuyEth) + 0.002 }]
  for (const [role, ws] of [["bundle", r.bundle], ["sniper", r.snipers], ["holder", r.holders]] as const) for (const w of ws) rows.push({ publicKey: w.publicKey, label: w.label, role, buyEth: w.amount, needEth: need(w.amount) })
  return { rows, totalEth: rows.reduce((a, x) => a + x.needEth, 0), warnings: r.warnings }
}

export async function planWithBalances(env: Env, f: LaunchForm): Promise<Plan & { resolved: Resolved }> {
  const r = resolveWallets(env, f)
  const plan = fundingPlan(f, r)
  const have = await env.api.rh.ethBalances(plan.rows.map((x) => x.publicKey).filter(Boolean))
  for (const row of plan.rows) {
    row.haveEth = row.publicKey ? have.get(row.publicKey.toLowerCase()) ?? 0 : 0
    // a funding transfer is rounded down to 8 decimals, and the balances are floats: compare on the same grid, with
    // 1e-9 of slack, so 0.0520000000001 vs 0.052000000000000001 is "holds what it needs" and not a phantom shortfall
    const need = Math.ceil(row.needEth * 1e8 - 1e-6) / 1e8
    // a row with no publicKey yet is a buyer that will be created at launch: it holds 0 and needs its whole buy funded
    row.shortEth = row.publicKey ? Math.max(0, need - Math.floor(row.haveEth * 1e8 + 0.5) / 1e8 - 1e-9) : need
    if (row.shortEth < 1e-9) row.shortEth = 0
  }
  plan.shortEth = plan.rows.reduce((a, x) => a + (x.shortEth ?? 0), 0)
  return { ...plan, resolved: r }
}

export async function fundPlan(env: Env, f: LaunchForm): Promise<{ from: string; results: FundResult[] }> {
  const plan = await planWithBalances(env, materialize(env, f))
  const funding = env.wallets.main()
  const targets = plan.rows.filter((x) => (x.shortEth ?? 0) > 0 && x.publicKey.toLowerCase() !== funding?.publicKey.toLowerCase()).map((x) => ({ publicKey: x.publicKey, eth: +(x.shortEth ?? 0).toFixed(8) }))
  if (!targets.length) return { from: funding?.publicKey ?? "", results: [] }
  return fundDirect(env, targets)
}

async function checkDevBalance(env: Env, f: LaunchForm, r: Resolved): Promise<void> {
  const row = fundingPlan(f, r).rows[0]
  const acct = await env.api.rh.account(r.dev.publicKey)
  if (Number(acct.balanceEth) < row.needEth) throw new AppError(`Dev wallet ${r.dev.publicKey} holds ${acct.balanceEth} HYPE; the launch needs about ${row.needEth.toFixed(5)} HYPE (dev buy + gas). Nothing was sent.`, "insufficient_funds", 409, "Fund it from the ★ wallet (Funding plan → Fund) or send HYPE to it")
}

export type SimulateResult = { predicted?: Built["predicted"]; launchFeeEth?: number; expected: Built["expected"]; simulation: Simulation; exempt: number; warnings: string[] }

/** Build the launch and run every transaction through eth_call. Nothing is sent. */
export async function simulate(env: Env, f: LaunchForm): Promise<SimulateResult> {
  const r = resolveWallets(env, f)
  env.wallets.assertBackedUp(r.dev.publicKey)
  await checkDevBalance(env, f, r)
  const built = await env.api.rh.tradeLocal(createBody(env, f, r.dev.publicKey, recoverySet(env, f, r)))
  const simulation = await env.api.rh.simulate(built.transactions)
  return { predicted: built.predicted, launchFeeEth: 0, expected: built.expected, simulation, exempt: 0, warnings: r.warnings }
}

// ── the run ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function newRecord(f: LaunchForm): LaunchRecord {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  return { id, createdAt: new Date().toISOString(), status: "running", name: f.name, symbol: f.symbol, image: f.image, launchpad: f.launchpad ?? "ascend", dev: "", wallets: { bundle: [], snipers: [], holders: [] }, hashes: { buys: [] } }
}

/** Run a launch to the end. Never throws. `onLive` fires the moment the coin exists (the route arms the auto-sell there). */
/** Every per-wallet auto-sell bar of a resolved launch, keyed by lowercase address. */
export function exitBars(f: LaunchForm, r: Resolved): Record<string, number> {
  const bars: Record<string, number> = {}
  if (f.devSellAtHypeIn && f.devSellAtHypeIn > 0) bars[r.dev.publicKey.toLowerCase()] = f.devSellAtHypeIn
  for (const w of [...r.bundle, ...r.snipers, ...r.holders]) if (w.sellAtHypeIn && w.sellAtHypeIn > 0 && w.publicKey) bars[w.publicKey.toLowerCase()] = w.sellAtHypeIn
  return bars
}

export async function execute(env: Env, record: LaunchRecord, f: LaunchForm, log: Log, onLive?: (token: string, devReceiver: string, bars: Record<string, number>) => void): Promise<void> {
  const api = env.api
  const slippage = f.slippage ?? env.slippage
  try {
    f = materialize(env, f)
    const r = resolveWallets(env, f)
    for (const w of [r.dev, ...r.bundle, ...r.snipers, ...r.holders]) env.wallets.assertBackedUp(w.publicKey)
    record.dev = r.dev.publicKey
    record.wallets = { bundle: r.bundle.map((w) => w.publicKey), snipers: r.snipers.map((w) => w.publicKey), holders: r.holders.map((w) => w.publicKey) }
    env.launches.save(record)
    const pad: Launchpad = f.launchpad ?? "ascend"
    const padLabel = LAUNCHPAD_NAMES[pad]
    log("prepare", `${padLabel} · dev ${r.dev.publicKey} · ${r.bundle.length} bundle · ${r.snipers.length} snipers · ${r.holders.length} holders · ${feeText(env, f)}`)

    let plan = await planWithBalances(env, f)
    let short = plan.rows.filter((x) => (x.shortEth ?? 0) > 0)
    if (short.length && f.fundFirst !== false) {
      log("fund", `${short.length} wallet(s) short of HYPE (${plan.shortEth?.toFixed(5)} in total): funding them from the ★ wallet…`)
      const funded = await fundPlan(env, f)
      for (const x of funded.results) log("fund", x.error ? `${x.publicKey}: ${x.error}` : `${x.publicKey} +${x.eth} HYPE${x.confirmed ? "" : " (not confirmed yet)"}`, { hash: x.hash, link: x.hash ? txLink(x.hash) : undefined, level: x.error ? "error" : "ok" })
      plan = await planWithBalances(env, f)
      short = plan.rows.filter((x) => (x.shortEth ?? 0) > 0)
    }
    if (short.length) throw new AppError(`${short.length} wallet(s) are short of HYPE (total ${plan.shortEth?.toFixed(5)}): ${short.map((x) => `${x.label} needs ${x.needEth.toFixed(5)}, has ${(x.haveEth ?? 0).toFixed(5)}`).join("; ")}. Nothing was sent.`, "insufficient_funds", 409, "Send HYPE to the ★ wallet, then launch again")
    log("prepare", "Every wallet holds what the plan asks for", { level: "ok" })

    // the launch: Ascend [wrap] [approve] create with the dev bag to the desk; Montra / BOXA one native create (bag to the wallet, moved below)
    const built = await api.rh.tradeLocal(createBody(env, f, r.dev.publicKey, recoverySet(env, f, r)))
    const devReceiver = built.predicted?.devReceiver ?? r.dev.publicKey
    record.devReceiver = devReceiver
    log("create", `${built.transactions.length} transaction(s): ${built.transactions.map((t) => t.label).join(" → ")}${devReceiver.toLowerCase() !== r.dev.publicKey.toLowerCase() ? ` · dev bag to the desk ${devReceiver}` : ""}${built.predicted?.token ? ` · the coin will be ${built.predicted.token}` : ""}`)

    const devAccount = env.wallets.accountOf(r.dev.publicKey)
    const hashes = await sendAll(api, devAccount, built.transactions, { confirm: false, onStep: (label, hash) => log("create", `${label} sent`, { hash, link: txLink(hash) }) })
    const createHash = hashes[built.transactions.findIndex((t) => t.label === "create")] ?? hashes[hashes.length - 1]
    record.hashes.create = createHash
    env.launches.save(record)
    if (!(await waitSuccess(api, createHash, 120_000, (m) => log("create", m)))) throw new Error(`launch ${createHash} not confirmed in 2 minutes; check ${txLink(createHash)} before launching again`)
    const res = await api.launchResult(createHash, devReceiver as `0x${string}`, pad)
    if (!res) throw new Error(`launch ${createHash} confirmed but the coin could not be read off its receipt`)
    const token = res.token
    record.token = token
    record.curve = res.poolId
    record.escrow = res.escrow ?? undefined
    record.links = { pons: padToken(pad, token) }
    env.launches.save(record)
    log("live", `Live on ${padLabel}: ${padToken(pad, token)}${res.devTokens > 0n ? ` · dev holds ${Number(res.devTokens / 10n ** 18n).toLocaleString()} tokens` : ""}`, { hash: createHash, link: padToken(pad, token), token, level: "ok" })

    // a pad launch minted the dev bag to the wallet: one transfer puts it in the desk, so the exit is one approval-free call
    let exitReceiver = devReceiver
    if (pad !== "ascend" && res.devTokens > 0n) {
      try {
        const move = await api.bagToDeskTx(r.dev.publicKey as `0x${string}`, token as `0x${string}`)
        if (move) {
          const [h] = await sendAll(api, devAccount, [move.tx], { confirm: true })
          exitReceiver = move.desk
          log("desk", `Dev bag moved into the desk ${move.desk} (${Number(move.amount / 10n ** 18n).toLocaleString()} tokens): the exit is one call, nothing to approve`, { hash: h, link: txLink(h), level: "ok" })
        } else log("desk", "The dev wallet has no v2 desk: its bag stays in the wallet and the exit goes through the router (two approvals first)", { level: "warn" })
      } catch (e) {
        log("desk", `Could not move the dev bag into the desk (${e instanceof Error ? e.message.slice(0, 120) : e}); it stays in the wallet`, { level: "warn" })
      }
    }
    onLive?.(token, exitReceiver, exitBars(f, r))

    const buy = async (w: Picked, stage: string): Promise<void> => {
      const row: LaunchRecord["hashes"]["buys"][number] = { publicKey: w.publicKey, role: stage }
      record.hashes.buys.push(row)
      try {
        const b = await api.rh.tradeLocal({ wallet: w.publicKey, action: "buy", token, amount: w.amount, denominatedInEth: "true", slippage: 100 })
        const hs = await sendAll(api, env.wallets.accountOf(w.publicKey), b.transactions, { confirm: true, onStep: (label, hash) => { if (label === "buy") row.hash = hash } })
        row.hash = row.hash ?? hs[0]
        log(stage, `${w.label} bought ${w.amount} HYPE → ~${Math.round(b.expected.tokens).toLocaleString()} tokens${b.venue === "desk" ? " (via its desk)" : ""}`, { hash: row.hash, link: txLink(row.hash), level: "ok" })
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e)
        log(stage, `${w.label}: ${row.error}`, { level: "error" })
      }
    }

    const jobs: Promise<void>[] = []
    if (r.bundle.length) log("bundle", `${r.bundle.length} bundle buys of ${amounts(r.bundle)}, all at once`)
    for (const w of r.bundle) jobs.push(buy(w, "bundle"))
    if (r.snipers.length) log("snipers", `${r.snipers.length} sniper buys of ${amounts(r.snipers)}, every ${env.sniperGapMs} ms`)
    r.snipers.forEach((w, i) => jobs.push(sleep(env.sniperGapMs * (i + 1)).then(() => buy(w, "snipers"))))
    if (r.holders.length && f.stagger) jobs.push(runStagger(env, r.holders, f.stagger, token, Date.now(), buy, log))
    else if (r.holders.length) {
      log("holders", `${r.holders.length} holder buys of ${amounts(r.holders)} over ${env.holderWindowS}s, starting in ${env.holderDelayS}s`)
      r.holders.forEach((w, i) => {
        const at = env.holderDelayS * 1000 + ((i + Math.random()) / r.holders.length) * env.holderWindowS * 1000
        jobs.push(sleep(at).then(() => buy(w, "holders")))
      })
    }
    await Promise.all(jobs)

    const failed = record.hashes.buys.filter((b) => b.error).length
    record.status = "done"
    env.launches.save(record)
    log("done", `Launch finished: ${record.hashes.buys.length - failed}/${record.hashes.buys.length} buys landed · ${padToken(pad, token)}`, { level: failed ? "warn" : "ok", link: padToken(pad, token), done: true })
  } catch (e) {
    record.status = "failed"
    record.error = e instanceof Error ? e.message : String(e)
    env.launches.save(record)
    const code = (e as { code?: string })?.code
    log("failed", `${record.error}${code ? ` · ${code}` : ""}`, { level: "error", done: true })
  }
}

const rangeText = (r: StaggerRules) => r.minOutsideHype > 0 && r.maxOutsideHype > 0 ? `${r.minOutsideHype}–${r.maxOutsideHype} HYPE` : r.minOutsideHype > 0 ? `≥ ${r.minOutsideHype} HYPE` : r.maxOutsideHype > 0 ? `≤ ${r.maxOutsideHype} HYPE` : "any"

/**
 * The staggered buys, one wallet after another. Before each buy the gate runs every 2 s: stop the run if one of our
 * wallets has sold since the launch; buy when outsiders' net buying over the window is inside the range; otherwise
 * wait, and skip the wallet once its give-up time has passed. Every verdict is logged.
 */
async function runStagger(env: Env, ws: Picked[], rules: StaggerRules, token: string, launchedAt: number, buy: (w: Picked, stage: string) => Promise<void>, log: Log): Promise<void> {
  const gated = rules.minOutsideHype > 0 || rules.maxOutsideHype > 0
  log("stagger", `${ws.length} staggered buys of ${amounts(ws)}: first in ${rules.startDelayS}s, then ${rules.gapMinS}–${rules.gapMaxS}s apart` +
    (gated ? ` · buy only while outsiders' net buying in the last ${rules.windowS}s is ${rangeText(rules)} (give up on a wallet after ${Math.round(rules.giveUpS / 60)} min)` : " · no outside-flow gate") +
    (rules.stopOnOwnSell ? " · stop if any of our wallets sells" : ""))
  if ((gated || rules.stopOnOwnSell) && !env.flow) log("stagger", "No tape reader in this environment: the gates cannot be checked, every buy goes out", { level: "warn" })
  await sleep(rules.startDelayS * 1000)
  let bought = 0, skipped = 0
  for (const [i, w] of ws.entries()) {
    const deadline = Date.now() + rules.giveUpS * 1000
    let lastNote = 0
    let verdict: "buy" | "skip" | "stop" = "buy"
    while (env.flow) {
      if (rules.stopOnOwnSell && env.flow.ownSells(token, launchedAt) > 0) { verdict = "stop"; break }
      if (!gated) { verdict = "buy"; break }
      const flow = env.flow.outsideNet(token, rules.windowS * 1000)
      const inRange = flow.net >= rules.minOutsideHype && (rules.maxOutsideHype <= 0 || flow.net <= rules.maxOutsideHype)
      if (inRange) { log("stagger", `${w.label}: green light · outsiders' net in the last ${rules.windowS}s = ${flow.net.toFixed(3)} HYPE (${flow.buys} buys, ${flow.sells} sells)`); verdict = "buy"; break }
      if (Date.now() >= deadline) { verdict = "skip"; log("stagger", `${w.label}: skipped, outsiders' net stayed outside ${rangeText(rules)} for ${Math.round(rules.giveUpS / 60)} min (last ${flow.net.toFixed(3)} HYPE)`, { level: "warn" }); break }
      if (Date.now() - lastNote >= 15_000) {
        lastNote = Date.now()
        log("stagger", `${w.label} waiting: outsiders' net in the last ${rules.windowS}s = ${flow.net.toFixed(3)} HYPE (${flow.buys} buys, ${flow.sells} sells), ${flow.net < rules.minOutsideHype ? "below the floor" : "above the cap"} ${rangeText(rules)}`, { level: "warn" })
      }
      await sleep(2_000)
    }
    if (verdict === "stop") { log("stagger", `Stopped before ${w.label}: one of our wallets sold the coin (${ws.length - i} buy${ws.length - i === 1 ? "" : "s"} not placed)`, { level: "warn" }); break }
    if (verdict === "skip") { skipped++; continue }
    await buy(w, "stagger")
    bought++
    if (i < ws.length - 1) await sleep((rules.gapMinS + Math.random() * (rules.gapMaxS - rules.gapMinS)) * 1000)
  }
  log("stagger", `Stagger finished: ${bought} bought, ${skipped} skipped`, { level: skipped ? "warn" : "ok" })
}

export type CreatePreview = { transactions: EvmTx[]; predicted?: Built["predicted"] }
