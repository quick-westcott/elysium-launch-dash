"use client"

import * as React from "react"
import { Button } from "./ui/button"
import { Input, Select } from "./ui/input"
import { Pill } from "./ui/pill"
import { toast, toastFailure } from "./ui/toast"
import { api, del, post, put, failureOf } from "@/lib/client"
import { chain } from "@/lib/chain"

type Exit = { id: string; token: string; usd: number; nextBuyHype: number; scope: "all" | "noDev"; bars?: Record<string, number>; fired?: Array<{ publicKey: string; why: string; hash?: string; at: number }>; status: string; firedBy?: string; netUsd?: number; netHype?: number; armedWallets?: number; hashes?: string[]; error?: string; armedAt: number }
type Wallet = { publicKey: string; label: string }

/**
 * The auto-sell on a coin: SELL @ $ net outside in, or on the next outside buy of at least N HYPE, whichever first.
 * Armed from the launch form the moment the coin exists, or here. Pre-signed sells for every holding wallet (desk
 * sells where the coin sits in a desk), fired through the fan-out on the trigger.
 */
export function ExitCard({ token, main, wallets = [] }: { token: string; main: string | null; wallets?: Wallet[] }) {
  const [exits, setExits] = React.useState<Exit[]>([])
  const [usd, setUsd] = React.useState("")
  const [next, setNext] = React.useState("1")
  const [scope, setScope] = React.useState<"all" | "noDev">("all")
  const [bars, setBars] = React.useState<Record<string, string>>({})
  const [showBars, setShowBars] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)
  const barsOf = (): Record<string, number> => Object.fromEntries(Object.entries(bars).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)]))
  const nBars = Object.keys(barsOf()).length

  const load = React.useCallback(() => { api<{ exits: Exit[] }>(`/api/trading/exits?token=${token}`).then((r) => setExits(r.exits)).catch(() => {}) }, [token])
  React.useEffect(() => { load(); const t = setInterval(load, 3_000); return () => clearInterval(t) }, [load])

  const armed = exits.find((e) => e.status === "armed")
  const arm = async () => {
    setBusy("arm")
    try {
      await post("/api/trading/exits", { token, usd: Number(usd) || 0, nextBuyHype: Number(next) || 0, scope, devWallet: main, bars: barsOf() })
      toast({ tone: "ok", title: "Auto-sell armed", detail: "Pre-signing a sell for every wallet that holds the coin." })
      load()
    } catch (e) { toastFailure(failureOf(e)) } finally { setBusy(null) }
  }
  const cancel = async (id: string) => { setBusy("cancel"); try { await del(`/api/trading/exits?id=${id}`); load() } catch (e) { toastFailure(failureOf(e)) } finally { setBusy(null) } }
  const fire = async (id: string) => { setBusy("fire"); try { await put("/api/trading/exits", { id }); toast({ tone: "ok", title: "Sells broadcast" }); load() } catch (e) { toastFailure(failureOf(e)) } finally { setBusy(null) } }

  return (
    <div className="flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm">
      <div className="flex items-center justify-between"><span className="font-medium">Auto-sell</span>{armed ? <Pill tone="warn">armed · {armed.armedWallets ?? 0} pre-signed</Pill> : <Pill tone="muted">off</Pill>}</div>
      {armed ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <span>{armed.usd > 0 ? `$${armed.usd} net in` : ""}{armed.usd > 0 && armed.nextBuyHype > 0 ? " or " : ""}{armed.nextBuyHype > 0 ? `next outside buy ≥ ${armed.nextBuyHype} ${chain.symbol}` : ""}{armed.usd > 0 || armed.nextBuyHype > 0 ? ` → ${armed.scope === "noDev" ? "sell all, no dev" : "sell everything"}` : "no sell-everything rule"}</span>
          {armed.bars && Object.keys(armed.bars).length ? <span>· per-wallet bars: {Object.entries(armed.bars).map(([k, v]) => `${wallets.find((w) => w.publicKey.toLowerCase() === k)?.label ?? chain.short(k)} @ ${v}`).join(", ")} {chain.symbol}</span> : null}
          <span>· outside in so far {(armed.netHype ?? 0).toFixed(3)} {chain.symbol} (${Math.round(armed.netUsd ?? 0)})</span>
          {armed.fired?.length ? <span className="text-ok">· sold on their bar: {armed.fired.map((f) => wallets.find((w) => w.publicKey.toLowerCase() === f.publicKey.toLowerCase())?.label ?? chain.short(f.publicKey)).join(", ")}</span> : null}
          <Button size="xs" variant="destructive" className="ml-auto" onClick={() => void fire(armed.id)} disabled={!!busy}>Sell now</Button>
          <Button size="xs" variant="ghost" onClick={() => void cancel(armed.id)} disabled={!!busy}>disarm</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">sell everything @ $</span>
            <Input inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} className="h-7 w-16 font-mono text-xs" placeholder="off" aria-label="Dollar bar" />
            <span className="text-muted-foreground">net in · or next buy ≥</span>
            <Input inputMode="decimal" value={next} onChange={(e) => setNext(e.target.value)} className="h-7 w-14 font-mono text-xs" placeholder="off" aria-label="Next buy size" />
            <span className="text-muted-foreground">{chain.symbol}</span>
            <Select value={scope} onChange={(e) => setScope(e.target.value as "all" | "noDev")} className="h-7 w-28 text-xs"><option value="all">incl. dev</option><option value="noDev">no dev</option></Select>
            <Button size="xs" onClick={() => void arm()} disabled={!!busy || (!(Number(usd) > 0) && !(Number(next) > 0) && !nBars)}>{busy === "arm" ? "Arming…" : "Arm"}</Button>
          </div>
          {wallets.length ? (
            <button type="button" className="text-muted-foreground hover:text-foreground w-fit underline-offset-4 hover:underline" onClick={() => setShowBars((v) => !v)}>{showBars ? "▴" : "▾"} per-wallet bars{nBars ? ` (${nBars} set)` : ""}</button>
          ) : null}
          {showBars ? (
            <div className="flex flex-col gap-1 rounded-md border border-dashed p-2">
              <p className="text-muted-foreground">Each wallet sells its whole bag on its own once <b className="text-foreground">outside {chain.symbol} in</b> (strangers' buys − their sells since the arm; our wallets and desks never count) reaches its bar. The others keep holding. The rules above sell whatever is left.</p>
              {wallets.map((w) => (
                <label key={w.publicKey} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{w.publicKey === main ? "★ " : ""}{w.label} <span className="text-muted-foreground font-mono">{chain.short(w.publicKey)}</span></span>
                  <span className="text-muted-foreground">@ outside in ≥</span>
                  <Input inputMode="decimal" value={bars[w.publicKey.toLowerCase()] ?? ""} onChange={(e) => setBars((b) => ({ ...b, [w.publicKey.toLowerCase()]: e.target.value }))} className="h-7 w-16 font-mono text-xs" placeholder="–" aria-label={`${w.label} bar`} />
                  <span className="text-muted-foreground">{chain.symbol}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {exits.filter((e) => e.status !== "armed").slice(0, 3).map((e) => (
        <div key={e.id} className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <Pill tone={e.status === "done" ? "ok" : e.status === "error" ? "error" : "muted"}>{e.status}</Pill>
          <span>{e.firedBy ?? [e.usd > 0 ? `$${e.usd} net in` : "", e.nextBuyHype > 0 ? `next buy ≥ ${e.nextBuyHype}` : "", e.bars && Object.keys(e.bars).length ? `${Object.keys(e.bars).length} per-wallet bar${Object.keys(e.bars).length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}</span>
          {e.hashes?.length ? <span>{e.hashes.length} sell{e.hashes.length === 1 ? "" : "s"} sent</span> : null}
          {e.error ? <span className="text-destructive">{e.error}</span> : null}
        </div>
      ))}
    </div>
  )
}
