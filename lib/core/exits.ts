/**
 * The auto-sell: SELL @ $ net outside in, or on the next outside buy of at least N HYPE, whichever comes first
 * (those two sell EVERYTHING still held), plus a bar PER WALLET on "outside HYPE in": the HYPE outsiders have
 * net-put into the coin since the rule was armed (their buys minus their sells; our wallets and desks never count).
 * A wallet whose bar is crossed sells on its own while the others keep holding, so the exits ladder out.
 *
 * Armed per coin (from the launch form the moment the coin exists, or from the Trading page). The watcher pre-signs
 * one sell per wallet that holds the coin the moment it is armed (a desk sell where the coin sits in a desk: one
 * call, nothing to approve; the router sell otherwise, its approvals sent first), re-signs every 8 s and on every own
 * buy, polls the pool's tape every 600 ms, and on the trigger broadcasts every pre-signed sell at once through the
 * fan-out. Rules live in the record store (lib/kv.ts: exits.json on the server, localStorage in demo mode), so a restart or a reload re-arms them.
 *
 * "Outside" means not one of our wallets and not one of our desks. Our own buys never trigger our own exit.
 */
import { formatEther, keccak256, parseEther, type Address, type Hex } from "viem"
import { ELYSIUM_CHAIN_ID, publicClient, sendRaw } from "../elysium/chain"
import { allDesks } from "../elysium/desk"
import { swapsOf, type Swap } from "../elysium/tape"
import type { ElysiumApi } from "../elysium/api"
import { kv } from "../kv"
import { appState } from "../state"
import { signTx, Nonces } from "./evm"
import type { WalletStore } from "./env"

export type ExitRule = {
  id: string
  token: string
  /** net outside HYPE bought, in dollars, that fires the sell; 0 = off */
  usd: number
  /** the first outside buy of at least this many HYPE fires the sell; 0 = off */
  nextBuyHype: number
  scope: "all" | "noDev"
  /** per wallet (lowercase address): sell this wallet's bag once outside HYPE in ≥ the bar; absent/0 = only the rules above */
  bars?: Record<string, number>
  devWallet: string
  devReceiver: string
  armedAt: number
  status: "armed" | "fired" | "done" | "cancelled" | "error"
  firedBy?: string
  /** wallets already sold by their own bar */
  fired?: Array<{ publicKey: string; why: string; hash?: string; at: number }>
  netUsd?: number
  /** outside HYPE in so far (their buys − their sells since the arm) */
  netHype?: number
  armedWallets?: number
  hashes?: string[]
  error?: string
}

type Armed = { publicKey: string; raw: Hex; hash: Hex; nonce: number; via: "desk" | "router" }
type Live = { rule: ExitRule; armed: Armed[]; cursor: bigint; netHype: number; tick: ReturnType<typeof setInterval> | null; rearm: ReturnType<typeof setInterval> | null; arming: Promise<void> | null; firing: boolean }

export type ExitDeps = { api: () => ElysiumApi; wallets: WalletStore }
export type Exits = ReturnType<typeof createExits>

/** The auto-sell watcher over a wallet store and a chain client (the server's folder, or the browser's keystore). One per process / tab. */
export function createExits(deps: ExitDeps) {
  const state = appState("exits", () => ({ live: new Map<string, Live>(), hypeUsd: 0, hypeAt: 0 }))
  const readRules = (): ExitRule[] => kv().read<ExitRule[]>("exits", [])
  const saveRules = (rules: ExitRule[]) => kv().write("exits", rules.slice(-200))
  const POLL_MS = 600
  const REARM_MS = 8_000

  function persist(rule: ExitRule): void {
    const all = readRules().filter((r) => r.id !== rule.id)
    all.push(rule)
    saveRules(all)
  }

  /** HYPE in dollars from Hyperliquid's own mid (public, no key), cached a minute. */
  async function hypeUsd(): Promise<number> {
    if (Date.now() - state.hypeAt < 60_000 && state.hypeUsd > 0) return state.hypeUsd
    try {
      const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }), signal: AbortSignal.timeout(8_000) })
      const mids = await r.json() as Record<string, string>
      const usd = Number(mids?.HYPE)
      if (Number.isFinite(usd) && usd > 0) { state.hypeUsd = usd; state.hypeAt = Date.now() }
    } catch { /* keep the last */ }
    return state.hypeUsd
  }

  const ours = (): Set<string> => {
    const s = new Set(deps.wallets.list().map((w) => w.publicKey.toLowerCase()))
    for (const d of Object.values(allDesks())) s.add(d.toLowerCase())
    return s
  }

  /** Pre-sign a sell for every wallet of ours that holds the coin (its desk's bag first). */
  async function arm(live: Live): Promise<void> {
    const api = deps.api()
    const token = live.rule.token as Address
    const done = new Set((live.rule.fired ?? []).map((f) => f.publicKey.toLowerCase()))
    const wallets = deps.wallets.list().filter((w) => !(live.rule.scope === "noDev" && w.publicKey.toLowerCase() === live.rule.devWallet.toLowerCase()) && !done.has(w.publicKey.toLowerCase()))
    const next: Armed[] = []
    await Promise.all(wallets.map(async (w) => {
      try {
        deps.wallets.assertBackedUp(w.publicKey)
        const built = await api.rh.tradeLocal({ wallet: w.publicKey, action: "sell", token, amount: "100%", slippage: 100 }).catch(() => null)
        if (!built) return
        const acct = await api.rh.account(w.publicKey)
        const nonces = new Nonces(acct)
        const account = deps.wallets.accountOf(w.publicKey)
        // approvals go out now, so the pre-signed sell sits at the nonce after them
        for (const t of built.transactions) {
          if (t.label === "approve") {
            const raw = await signTx(account, acct, nonces, t)
            await api.rh.send(raw)
            await api.waitSuccess(await api.rh.send(raw).then((r) => r.hash).catch(() => keccak256(raw)), 60_000).catch(() => {})
          }
        }
        const sells = built.transactions.filter((t) => t.label === "sell")
        for (const t of sells) {
          const raw = await signTx(account, acct, nonces, t)
          next.push({ publicKey: w.publicKey, raw, hash: keccak256(raw), nonce: nonces.take() - 1, via: built.venue === "desk" ? "desk" : "router" })
        }
      } catch (e) {
        console.warn(`[exits] ${w.label}: could not arm (${e instanceof Error ? e.message.slice(0, 80) : e})`)
      }
    }))
    live.armed = next
    live.rule.armedWallets = next.length
    persist(live.rule)
  }

  async function fire(live: Live, why: string, only?: Set<string>): Promise<void> {
    if (live.firing || live.rule.status !== "armed") return
    live.firing = true
    try {
      if (live.arming) await Promise.race([live.arming.catch(() => {}), new Promise((r) => setTimeout(r, 1_500))])
      const set = only ? live.armed.filter((a) => only.has(a.publicKey.toLowerCase())) : live.armed
      if (!only) { live.rule.status = "fired"; live.rule.firedBy = why }
      console.log(`[exits] ${live.rule.token}: ${why}; broadcasting ${set.length} pre-signed sell(s)${only ? " (their own bars)" : ""}`)
      const t0 = Date.now()
      const hashes = await Promise.all(set.map((a) => sendRaw(a.raw).catch((e) => { console.warn(`[exits] ${a.publicKey.slice(0, 10)}: ${(e as Error).message.slice(0, 80)}`); return null })))
      live.rule.hashes = [...(live.rule.hashes ?? []), ...hashes.filter((h): h is Hex => Boolean(h))]
      console.log(`[exits] ${live.rule.token}: ${hashes.filter(Boolean).length}/${set.length} out in ${Date.now() - t0} ms`)
      if (only) {
        live.rule.fired = [...(live.rule.fired ?? []), ...set.map((a, i) => ({ publicKey: a.publicKey, why, hash: hashes[i] ?? undefined, at: Date.now() }))]
        live.armed = live.armed.filter((a) => !only.has(a.publicKey.toLowerCase()))
        live.rule.armedWallets = live.armed.length
        // every wallet gone, and no everything-rule left to wait for: the rule is done
        const wholeRule = live.rule.usd > 0 || live.rule.nextBuyHype > 0
        if (!live.armed.length && !wholeRule) { live.rule.status = "done"; live.rule.firedBy = "every wallet sold on its own bar"; persist(live.rule); stop(live.rule.id); return }
        persist(live.rule)
        return
      }
      live.rule.status = "done"
      persist(live.rule)
      stop(live.rule.id)
    } finally { live.firing = false }
  }

  async function poll(live: Live): Promise<void> {
    if (live.rule.status !== "armed") return
    try {
      const c = publicClient()
      if (live.cursor === 0n) live.cursor = (await c.getBlockNumber()) - 2n
      const head = await c.getBlockNumber()
      if (head < live.cursor) return
      const swaps = await swapsOf(live.rule.token as Address, live.cursor, head)
      live.cursor = head + 1n
      const mine = ours()
      const outside = swaps.filter((s: Swap) => !mine.has(s.trader.toLowerCase()))
      for (const s of outside) live.netHype += s.type === "buy" ? s.hype : -s.hype
      const usd = await hypeUsd()
      live.rule.netUsd = live.netHype * usd
      live.rule.netHype = live.netHype
      // per-wallet bars: whoever's bar outside HYPE in has crossed sells now, the rest keep holding
      const bars = live.rule.bars ?? {}
      const due = new Set(live.armed.map((a) => a.publicKey.toLowerCase()).filter((k) => bars[k] > 0 && live.netHype >= bars[k]))
      if (due.size) await fire(live, `outside HYPE in ${live.netHype.toFixed(3)} ≥ ${[...due].map((k) => bars[k]).join("/")} HYPE (${due.size} wallet${due.size === 1 ? "" : "s"})`, due)
      if (live.rule.status !== "armed") return
      const trigger = outside.find((s) => s.type === "buy" && live.rule.nextBuyHype > 0 && s.hype >= live.rule.nextBuyHype)
      if (trigger) return void fire(live, `outside buy of ${trigger.hype.toFixed(3)} HYPE ≥ ${live.rule.nextBuyHype} (block ${trigger.block})`)
      if (live.rule.usd > 0 && usd > 0 && live.rule.netUsd >= live.rule.usd) return void fire(live, `net outside flow $${Math.round(live.rule.netUsd)} ≥ $${live.rule.usd}`)
      // our own buy since the arm: a new bag to sign for
      if (swaps.some((s) => s.type === "buy" && mine.has(s.trader.toLowerCase()))) void rearm(live)
    } catch (e) { console.warn("[exits] tape", e instanceof Error ? e.message : e) }
  }

  function rearm(live: Live): void {
    if (live.arming || live.rule.status !== "armed") return
    live.arming = arm(live).finally(() => { live.arming = null })
  }

  function start(rule: ExitRule): Live {
    const live: Live = { rule, armed: [], cursor: 0n, netHype: 0, tick: null, rearm: null, arming: null, firing: false }
    state.live.set(rule.id, live)
    rearm(live)
    live.tick = setInterval(() => void poll(live), POLL_MS)
    live.rearm = setInterval(() => rearm(live), REARM_MS)
    const nBars = Object.keys(rule.bars ?? {}).length
    console.log(`[exits] watching ${rule.token}: ${rule.usd > 0 ? `$${rule.usd} net in` : ""}${rule.usd > 0 && rule.nextBuyHype > 0 ? " or " : ""}${rule.nextBuyHype > 0 ? `next outside buy ≥ ${rule.nextBuyHype} HYPE` : ""}${nBars ? ` · ${nBars} per-wallet bar(s) on outside HYPE in` : ""}`)
    return live
  }

  function stop(id: string): void {
    const live = state.live.get(id)
    if (!live) return
    if (live.tick) clearInterval(live.tick)
    if (live.rearm) clearInterval(live.rearm)
    state.live.delete(id)
  }

  /** Arm a rule on a coin (replaces any armed rule on the same coin). */
  function armExit(p: { token: string; usd: number; nextBuyHype: number; scope: "all" | "noDev"; devWallet: string; devReceiver?: string; bars?: Record<string, number> }): ExitRule {
    const bars: Record<string, number> = {}
    for (const [k, v] of Object.entries(p.bars ?? {})) if (/^0x[0-9a-fA-F]{40}$/.test(k) && Number(v) > 0) bars[k.toLowerCase()] = Number(v)
    if (!(p.usd > 0) && !(p.nextBuyHype > 0) && !Object.keys(bars).length) throw new Error("Set a dollar bar, a next-buy size, or a per-wallet bar on outside HYPE in")
    for (const [id, l] of state.live) if (l.rule.token.toLowerCase() === p.token.toLowerCase()) { l.rule.status = "cancelled"; persist(l.rule); stop(id) }
    const rule: ExitRule = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, token: p.token, usd: p.usd, nextBuyHype: p.nextBuyHype, scope: p.scope, bars: Object.keys(bars).length ? bars : undefined, devWallet: p.devWallet, devReceiver: p.devReceiver ?? p.devWallet, armedAt: Date.now(), status: "armed" }
    persist(rule)
    start(rule)
    return rule
  }

  function cancelExit(id: string): ExitRule | null {
    const live = state.live.get(id)
    const rule = live?.rule ?? readRules().find((r) => r.id === id) ?? null
    if (!rule) return null
    if (rule.status === "armed") { rule.status = "cancelled"; persist(rule); stop(id) }
    return rule
  }

  /** Fire an armed rule now, by hand. */
  async function fireExit(id: string): Promise<ExitRule | null> {
    const live = state.live.get(id)
    if (!live) return null
    await fire(live, "fired by hand")
    return live.rule
  }

  const listExits = (token?: string | null): ExitRule[] => {
    const rules = readRules()
    for (const l of state.live.values()) { const i = rules.findIndex((r) => r.id === l.rule.id); if (i >= 0) rules[i] = l.rule; else rules.push(l.rule) }
    return rules.filter((r) => !token || r.token.toLowerCase() === token.toLowerCase()).sort((a, b) => b.armedAt - a.armedAt)
  }

  /** On start: every rule still armed in the store is watched again. */
  function resumeExits(): void {
    for (const r of readRules()) if (r.status === "armed" && !state.live.has(r.id)) start(r)
  }
  return { armExit, cancelExit, fireExit, listExits, resumeExits }
}

export const CHAIN_ID = ELYSIUM_CHAIN_ID
export const fmtHype = (wei: bigint) => formatEther(wei)
export const toWei = (n: number) => parseEther(String(n) as `${number}`)
