"use client"

import * as React from "react"
import { Button } from "./ui/button"
import { Input, Select } from "./ui/input"
import { Mono } from "./ui/table"
import { toast, toastFailure } from "./ui/toast"
import { api, post, failureOf } from "@/lib/client"
import { chain } from "@/lib/chain"

type Status = { publicKey: string; desk: string | null; version?: number; latest?: number; hype?: string; tokens?: string }
type Wallet = { publicKey: string; label: string }

/**
 * The desk of one wallet: one contract it owns that holds HYPE and trades the pool directly, so a sell is one call
 * with nothing to approve (and the launch drops the dev bag in it). Deploy once per wallet, fund it for buys, take
 * HYPE or the coin back out. Buys and sells through it happen on their own: the row buttons use the desk whenever
 * the wallet has one.
 */
export function DeskCard({ wallets, main, token }: { wallets: Wallet[]; main: string | null; token?: string | null }) {
  const [wallet, setWallet] = React.useState("")
  const [status, setStatus] = React.useState<Status | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [fund, setFund] = React.useState("0.5")
  const pk = wallet || main || wallets[0]?.publicKey || ""

  const load = React.useCallback(() => {
    if (!pk) return
    api<Status>(`/api/desk?wallet=${pk}${token ? `&token=${token}` : ""}`).then(setStatus).catch(() => setStatus(null))
  }, [pk, token])
  React.useEffect(() => { load(); const t = setInterval(load, 4_000); return () => clearInterval(t) }, [load])

  const run = (name: string, body: Record<string, unknown>, title: string) => async () => {
    setBusy(name)
    try {
      const r = await post<{ desk: string; hash?: string }>("/api/desk", { ...body, publicKey: pk })
      toast({ tone: "ok", title, detail: r.hash ? <a className="underline" href={chain.explorerTx(r.hash)} target="_blank" rel="noreferrer">{r.hash.slice(0, 14)}…</a> : `desk ${r.desk.slice(0, 10)}…` })
      load()
    } catch (e) { toastFailure(failureOf(e)) } finally { setBusy(null) }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Desk</span>
        <Select value={pk} onChange={(e) => setWallet(e.target.value)} className="h-7 max-w-44 text-xs" aria-label="Desk wallet">
          {wallets.map((w) => <option key={w.publicKey} value={w.publicKey}>{w.publicKey === main ? "★ " : ""}{w.label}</option>)}
        </Select>
        {status?.desk ? <Mono className="text-muted-foreground text-xs">{status.desk.slice(0, 8)}…{status.desk.slice(-4)}</Mono> : <span className="text-muted-foreground text-xs">none yet</span>}
        {status?.desk && status.version ? <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${status.version >= (status.latest ?? 2) ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"}`} title={status.version >= (status.latest ?? 2) ? "trades Ascend, Montra and BOXA pools" : "v1: Ascend pools only — redeploy as v2 to trade Montra / BOXA coins through it"}>v{status.version}</span> : null}
      </div>
      {status?.desk ? (
        <>
          <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
            <span><b className="text-foreground">{Number(status.hype ?? 0).toFixed(4)} {chain.symbol}</b> in the desk</span>
            {token ? <span><b className="text-foreground">{Number(status.tokens ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}</b> of the coin</span> : null}
          </div>
          {status.version !== undefined && status.version < (status.latest ?? 2) ? (
            <div className="border-warn/50 flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2 text-xs">
              <span className="text-warn">This is a v1 desk: it trades Ascend pools only. Montra and BOXA coins need v2.</span>
              <Button size="xs" variant="outline" onClick={run("upgrade", { action: "upgrade" }, "Desk redeployed as v2")} disabled={!!busy || Number(status.tokens) > 0} title={Number(status.tokens) > 0 ? "Withdraw the coin from the desk first" : "Pulls its HYPE back to the wallet, then deploys a v2 desk"}>{busy === "upgrade" ? "Upgrading…" : "Redeploy as v2"}</Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <Input inputMode="decimal" value={fund} onChange={(e) => setFund(e.target.value)} className="h-7 w-16 font-mono text-xs" aria-label="Fund amount" />
            <Button size="xs" variant="outline" onClick={run("fund", { action: "fund", amount: Number(fund) }, `Funded the desk with ${fund} ${chain.symbol}`)} disabled={!!busy}>{busy === "fund" ? "…" : "Fund"}</Button>
            <Button size="xs" variant="ghost" onClick={run("wh", { action: "withdrawHype" }, "HYPE withdrawn to the wallet")} disabled={!!busy || !(Number(status.hype) > 0)}>withdraw {chain.symbol}</Button>
            {token ? <Button size="xs" variant="ghost" onClick={run("wt", { action: "withdrawToken", token }, "Coin withdrawn to the wallet")} disabled={!!busy || !(Number(status.tokens) > 0)}>withdraw coin</Button> : null}
          </div>
          <p className="text-muted-foreground text-xs">Buys from this wallet's row go through the desk when it holds enough {chain.symbol}; every sell of what the desk holds is one call, nothing to approve. A launch from this wallet drops the dev bag here (Ascend puts it straight in; Montra and BOXA mint it to the wallet and it is moved in right after).</p>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" onClick={run("deploy", { action: "deploy" }, "Desk deployed")} disabled={!!busy || !pk}>{busy === "deploy" ? "Deploying…" : "Deploy a desk for this wallet"}</Button>
          <span className="text-muted-foreground text-xs">one contract, cents of gas; then sells need no approvals</span>
        </div>
      )}
    </div>
  )
}
