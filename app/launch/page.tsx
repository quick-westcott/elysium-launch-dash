"use client"

/**
 * Launch on Ascend (Elysium), the short way: fill the coin in, pick the trade fee and the auto-sell, pick how many wallets buy with it, press Launch.
 *
 *   1. the image goes to IPFS by itself when you press Launch (POST /api/launch/image → POST /api/ipfs; no upload button)
 *   2. every "new wallet" row is created (and backed up) right before the launch (POST /api/wallets)
 *   3. POST /api/launch; the ★ wallet tops short buyers up, the create goes out, the log streams in, and the moment the
 *      coin is live the Trading page opens on it
 *
 * Everything else (dev wallet, slippage, snipers, funding) sits under Advanced. There is no mint card: on Ascend the
 * address is derived from the whole form (the log shows it before the create is signed).
 */
import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ImagePlus, SlidersHorizontal } from "lucide-react"
import { ApiCalls, type ApiCall } from "@/components/api-calls"
import { FailureBox } from "@/components/failure"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { Pill } from "@/components/ui/pill"
import { Mono } from "@/components/ui/table"
import { Toggle } from "@/components/ui/toggle"
import { failureOf, get, post, subscribe, walletsChanged, type Failure } from "@/lib/api"
import { DEMO, TAB_NOTE } from "@/lib/browser/demo"
import { chain, LAUNCHPAD_BLURB, LAUNCHPAD_NAMES, LAUNCHPADS, type Launchpad } from "@/lib/chain"
import { BRAND_PAD } from "@/lib/brand"

type Wallet = { publicKey: string; label: string; role: string }
type PlanRow = { publicKey: string; label: string; role: string; buyEth: number; needEth: number; haveEth?: number; shortEth?: number }
type Plan = { rows: PlanRow[]; totalEth: number; shortEth?: number; warnings: string[]; dev: string; exempt: number }
type Sim = { predicted?: { token?: string; curve?: string; devReceiver?: string }; launchFeeEth?: number; expected: { tokens: number; eth: number }; simulation: { ok: boolean; steps: Array<{ label: string; ok: boolean; gasUsed: string | null; error: string | null }> }; exempt: number; warnings: string[]; calls?: ApiCall[] }
type LogEntry = { t: number; stage: string; msg: string; hash?: string; link?: string; token?: string; level?: "info" | "ok" | "warn" | "error"; done?: boolean }
/** One buyer row: a wallet of the folder, or null = a new wallet made at launch; the amount as typed. */
type Row = { publicKey: string | null; amount: string; sellAt: string }

const BUNDLE_COUNTS = [0, 1, 2, 3, 4, 6, 8, 12, 16]
const HOLDER_COUNTS = [0, 1, 2, 3, 4, 5, 6, 8, 10]
const DEV_CHIPS = ["0.05", "0.1", "0.25", "0.5", "1"]
const FEE_CHIPS: Array<[string, string]> = [["10000", "1 %"], ["20000", "2 %"], ["30000", "3 %"], ["50000", "5 %"], ["100000", "10 %"]]
/** BOXA's EXTRA fee on top of its hook's own cut, in bps: 0 is what its UI sends, 5 % the most it accepts. */
const BOXA_FEE_CHIPS: Array<[string, string]> = [["0", "0 %"], ["100", "1 %"], ["200", "2 %"], ["300", "3 %"], ["500", "5 %"]]
const LAUNCH_GAS_TEXT: Record<Launchpad, string> = { ascend: "~5.2M", montra: "~1.4M", boxa: "~1.9M" }
const ALL_CHIPS = ["0.05", "0.1", "0.25", "0.5", "1"]

const n = (v: string, d = 0) => (v.trim() === "" || Number.isNaN(Number(v)) ? d : Number(v))
const resize = (rows: Row[], count: number, fill: string): Row[] => Array.from({ length: count }, (_, i) => rows[i] ?? { publicKey: null, amount: fill, sellAt: "" })
const eth = (x: number | undefined) => (x === undefined ? "–" : Number(x).toLocaleString("en-US", { maximumFractionDigits: 5 }))

/** A small round choice button, the bundler's "chip". */
function Chip({ active, className = "", ...props }: React.ComponentProps<"button"> & { active?: boolean }) {
  return <button type="button" className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full border px-2.5 font-mono text-xs transition-colors disabled:opacity-50 ${active ? "bg-foreground text-background border-foreground" : "hover:bg-accent"} ${className}`} {...props} />
}

export default function LaunchPage() {
  const router = useRouter()
  const [f, setF] = React.useState({ name: "", symbol: "", description: "", twitter: "", telegram: "", website: "", devBuyEth: "0.1", slippage: "", feePpm: "10000", feeBps: "0", exitUsd: "", exitNext: "1", devSellAt: "" })
  const [pad, setPad] = React.useState<Launchpad>(BRAND_PAD)
  const [autoSell, setAutoSell] = React.useState(true)
  const [image, setImage] = React.useState<File | null>(null)
  const [preview, setPreview] = React.useState("")
  const [dragOver, setDragOver] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)
  // the wallets
  const [wallets, setWallets] = React.useState<Wallet[]>([])
  const [balances, setBalances] = React.useState<Map<string, number>>(new Map())
  const [main, setMain] = React.useState<string | null>(null)
  const [devWallet, setDevWallet] = React.useState("")
  const [devDesk, setDevDesk] = React.useState<string | null | undefined>(undefined)
  // the staggered buyers' rules (strings: edited freely; the route parses them)
  const [st, setSt] = React.useState({ startDelayS: "5", gapMinS: "8", gapMaxS: "25", windowS: "60", minHype: "0.5", maxHype: "20", giveUpMin: "10", stopOnOwnSell: true })
  const setSt1 = (k: keyof typeof st) => (e: React.ChangeEvent<HTMLInputElement>) => setSt((s) => ({ ...s, [k]: e.target.value }))
  const [bundle, setBundle] = React.useState<Row[]>(resize([], 2, "0.001"))
  const [holders, setHolders] = React.useState<Row[]>([])
  const [snipers, setSnipers] = React.useState<Row[]>([])
  const [advanced, setAdvanced] = React.useState(false)
  const [fundFirst, setFundFirst] = React.useState(true)
  // plan, simulation, the run
  const [plan, setPlan] = React.useState<Plan | null>(null)
  const [sim, setSim] = React.useState<Sim | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [failure, setFailure] = React.useState<Failure | null>(null)
  const [log, setLog] = React.useState<LogEntry[]>([])
  const [launchId, setLaunchId] = React.useState<string | null>(null)
  const [done, setDone] = React.useState<"live" | "error" | null>(null)
  const logRef = React.useRef<HTMLDivElement>(null)

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }))
  const dev = devWallet || main
  const mainBalance = main ? balances.get(main) : undefined
  const launching = launchId !== null && done === null
  const buyers = bundle.length + snipers.length + holders.length

  /** The form the routes take (lib/core/launch.ts normalizeForm). `publicKey: null` rows are new wallets; the launch resolves them first. */
  const form = (image = "", rows = { bundle, snipers, holders }, metadataUri?: string) => ({
    name: f.name, symbol: f.symbol, description: f.description, twitter: f.twitter, telegram: f.telegram, website: f.website, image, metadataUri,
    devWallet: devWallet || undefined, devBuyEth: n(f.devBuyEth), slippage: n(f.slippage) || undefined, fundFirst,
    launchpad: pad,
    feePpm: pad === "ascend" ? n(f.feePpm) || undefined : undefined,
    feeBps: pad === "boxa" ? n(f.feeBps) : undefined,
    exit: autoSell ? { usd: n(f.exitUsd), nextBuyHype: n(f.exitNext), scope: "all" as const } : undefined,
    devSellAtHypeIn: autoSell && n(f.devSellAt) > 0 ? n(f.devSellAt) : undefined,
    bundle: { wallets: rows.bundle.map((r) => ({ publicKey: r.publicKey, amount: n(r.amount), sellAtHypeIn: autoSell && n(r.sellAt) > 0 ? n(r.sellAt) : undefined })) },
    snipers: { wallets: rows.snipers.map((r) => ({ publicKey: r.publicKey, amount: n(r.amount), sellAtHypeIn: autoSell && n(r.sellAt) > 0 ? n(r.sellAt) : undefined })) },
    holders: { wallets: rows.holders.map((r) => ({ publicKey: r.publicKey, amount: n(r.amount), sellAtHypeIn: autoSell && n(r.sellAt) > 0 ? n(r.sellAt) : undefined })) },
    stagger: rows.holders.length ? { startDelayS: n(st.startDelayS, 5), gapMinS: n(st.gapMinS, 8), gapMaxS: n(st.gapMaxS, 25), windowS: n(st.windowS, 60), minOutsideHype: n(st.minHype, 0), maxOutsideHype: n(st.maxHype, 0), giveUpS: n(st.giveUpMin, 10) * 60, stopOnOwnSell: st.stopOnOwnSell } : undefined,
  })

  // the dev wallet's desk: where the dev bag lands
  React.useEffect(() => {
    if (!dev) { setDevDesk(undefined); return }
    let alive = true
    get<{ desk: string | null }>(`/api/desk?wallet=${dev}`).then((r) => { if (alive) setDevDesk(r.desk) }).catch(() => { if (alive) setDevDesk(null) })
    return () => { alive = false }
  }, [dev, wallets.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── data ──────────────────────────────────────────────────────────────────
  const loadWallets = React.useCallback(async () => {
    const r = await get<{ wallets: Wallet[]; mainWallet: string | null }>("/api/wallets")
    setWallets(r.wallets); setMain(r.mainWallet)
    if (r.wallets.length) get<{ rows: Array<{ publicKey: string; native: number }> }>("/api/wallets/balances").then((b) => setBalances(new Map(b.rows.map((x) => [x.publicKey, x.native])))).catch(() => {})
  }, [])
  React.useEffect(() => { void loadWallets().catch(() => {}) }, [loadWallets])
  React.useEffect(() => { const t = setInterval(() => void loadWallets().catch(() => {}), 20_000); return () => clearInterval(t) }, [loadWallets])

  React.useEffect(() => {
    if (!image) { setPreview(""); return }
    const url = URL.createObjectURL(image)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [image])

  // the cost, recomputed as the numbers change (the plan does not need the image)
  const planKey = JSON.stringify([pad, f.devBuyEth, devWallet, bundle, snipers, holders, f.slippage, f.feePpm, f.feeBps])
  React.useEffect(() => {
    const t = setTimeout(() => { post<Plan>("/api/launch/plan", form()).then(setPlan).catch(() => {}) }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey])

  // the launch log, then the Trading page the moment the coin is live
  React.useEffect(() => {
    if (!launchId) return
    return subscribe<LogEntry>(`/api/launch/${launchId}/log`, (e) => {
      setLog((xs) => [...xs, e])
      if (e.stage === "failed") setDone("error")
      if (e.stage === "live" && e.token) {
        setDone("live")
        const token = e.token
        setTimeout(() => router.push(`/trading?token=${encodeURIComponent(token)}&launch=${encodeURIComponent(launchId)}`), 900)
      }
    })
  }, [launchId, router])
  React.useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [log])

  // ── actions ───────────────────────────────────────────────────────────────
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name); setFailure(null)
    try { await fn() } catch (e) { setFailure(failureOf(e)) } finally { setBusy(null) }
  }
  const note = (stage: string, msg: string, level: LogEntry["level"] = "info") => setLog((xs) => [...xs, { t: Date.now(), stage, msg, level }])

  /** The image → IPFS, as part of Launch (and Simulate): POST /api/launch/image → { image } for the create's metadata. */
  const uploadImage = async (): Promise<{ image: string; metadataUri: string }> => {
    if (!image) throw { error: "Pick an image first" }
    const fd = new FormData()
    fd.set("file", image); fd.set("name", f.name || "coin"); fd.set("symbol", f.symbol || "COIN"); fd.set("description", f.description)
    for (const k of ["twitter", "telegram", "website"] as const) if (f[k]) fd.set(k, f[k])
    if (dev) fd.set("creator", dev)
    // every wallet of the launch plus the ★ funding wallet (it pays for the
    // buyers, so its key is the one to recover), so the metadata carries the
    // sealed launch stamp
    const set = [dev, main, ...[...bundle, ...snipers, ...holders].map((r) => r.publicKey)].filter(Boolean)
    if (set.length) fd.set("wallets", JSON.stringify([...new Set(set)]))
    const r = await fetchApp("/api/launch/image", fd)
    return { image: r.image, metadataUri: r.metadataUri }
  }
  /** Every "new wallet" row becomes a real wallet (POST /api/wallets); in demo mode the keys are downloaded right away so the launch may use them. */
  const resolveRows = async (): Promise<{ bundle: Row[]; snipers: Row[]; holders: Row[] }> => {
    const out = { bundle: [...bundle], snipers: [...snipers], holders: [...holders] }
    let made = 0
    for (const [key, role] of [["bundle", "bundle"], ["snipers", "sniper"], ["holders", "holder"]] as const) {
      const rows = out[key]
      const missing = rows.filter((r) => !r.publicKey).length
      if (!missing) continue
      const r = await post<{ dir: string; wallets: Array<{ publicKey: string; label: string }> }>("/api/wallets", { count: missing, role })
      const fresh = [...r.wallets]
      out[key] = rows.map((row) => (row.publicKey ? row : { ...row, publicKey: fresh.shift()!.publicKey }))
      made += r.wallets.length
    }
    if (made) {
      note("wallets", `${made} new wallet${made === 1 ? "" : "s"} created${DEMO ? "" : " and written to the folder"}`)
      if (DEMO) { const b = await post<{ count: number; files: string[] }>("/api/wallets/backup"); note("wallets", `Backup downloaded (${b.files.join(", ")}): the new keys are now usable`) }
      walletsChanged()
      void loadWallets().catch(() => {})
      setBundle(out.bundle); setSnipers(out.snipers); setHolders(out.holders)
    }
    return out
  }

  /** The trenchy.tools coin with our logo and links, and the default launch numbers: one click to a complete form. */
  const autofill = () => run("autofill", async () => {
    const blob = await fetch("/demo-logo.png").then((r) => r.blob())
    setImage(new File([blob], "trenchy-tools.png", { type: "image/png" }))
    setF((s) => ({ ...s, name: "trenchy.tools", symbol: "TRENCHY", description: "The easiest API to launch and trade with. One key, every launchpad, unsigned transactions you sign yourself.", twitter: "https://x.com/trenchytools", telegram: "https://t.me/trenchytools", website: "https://trenchy.tools", devBuyEth: "0.001" }))
    setBundle(resize([], 2, "0.05")); setHolders(resize([], 2, "0.05")); setSnipers([])
  })

  const simulate = () => run("simulate", async () => {
    setSim(null)
    const up = image ? await uploadImage() : { image: "https://placeholder.invalid/x", metadataUri: "" }
    setSim(await post<Sim>("/api/launch/simulate", form(up.image, undefined, up.metadataUri || undefined)))
  })

  const ready = !!f.name && !!f.symbol && !!image
  const short = fundFirst && plan !== null && (plan.shortEth ?? 0) > 0 && mainBalance !== undefined && mainBalance < (plan.shortEth ?? 0)
  const blocker = !main ? "Create a ★ wallet first (Wallets)" : !ready ? "Name, symbol and an image are needed" : short ? `Not enough ${chain.symbol} (short ${eth(plan!.shortEth)}, ★ has ${eth(mainBalance)})` : null

  const launch = () => run("launch", async () => {
    if (blocker) throw { error: blocker }
    if (!confirm(`Launch ${f.name} (${f.symbol}) with ${buyers} buyer wallet${buyers === 1 ? "" : "s"}? About ${plan ? eth(plan.totalEth) : "…"} ${chain.symbol} in total${plan?.shortEth ? `, ${eth(plan.shortEth)} ${chain.symbol} of it from the ★ wallet` : ""}. This sends real transactions.`)) return
    setLog([]); setDone(null); setSim(null)
    // new wallets first: their keys have to exist before the metadata is pinned, so the record can carry them
    const rows = await resolveRows()
    note("ipfs", `Pinning the image${pad === "ascend" ? " and Ascend's metadata" : ""} on IPFS…${pad === "montra" ? " (Montra's token-URI JSON is pinned with the launch)" : ""}`)
    const up = await uploadImage()
    note("ipfs", `Image pinned: ${up.image}${pad === "ascend" ? ` · metadata ${up.metadataUri}` : ""}`)
    const r = await post<{ id: string }>("/api/launch", form(up.image, rows, up.metadataUri))
    setLaunchId(r.id)
  })

  // ── pieces ────────────────────────────────────────────────────────────────
  const taken = new Set([...(dev ? [dev] : []), ...[...bundle, ...snipers, ...holders].map((r) => r.publicKey).filter(Boolean)])
  const Rows = ({ rows, onChange, prefix }: { rows: Row[]; onChange: (rows: Row[]) => void; prefix: string }) => (
    <div className="flex flex-col gap-1.5">
      {rows.length > 0 ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">all:
          {ALL_CHIPS.map((v) => <Chip key={v} className="h-6" onClick={() => onChange(rows.map((r) => ({ ...r, amount: v })))}>{v}</Chip>)}
        </div>
      ) : null}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-muted-foreground w-6 font-mono text-xs">{prefix}{i + 1}</span>
          <Input inputMode="decimal" className="h-8 w-24 font-mono text-xs" value={r.amount} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label={`${prefix}${i + 1} amount`} />
          <span className="text-muted-foreground text-xs">{chain.symbol}</span>
          <Select className="h-8 max-w-56 flex-1 text-xs" value={r.publicKey ?? ""} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, publicKey: e.target.value || null } : x)))} aria-label={`${prefix}${i + 1} wallet`}>
            <option value="">new wallet</option>
            {wallets.filter((w) => w.publicKey === r.publicKey || !taken.has(w.publicKey)).map((w) => <option key={w.publicKey} value={w.publicKey}>{w.label} · {chain.short(w.publicKey)} · {chain.fmt(balances.get(w.publicKey))} {chain.symbol}</option>)}
          </Select>
          {autoSell ? (
            <span className="flex items-center gap-1" title="This wallet sells its whole bag the moment outsiders have net-bought this much HYPE since launch (their buys − their sells; our wallets never count). Blank = only the sell-everything rules apply.">
              <span className="text-muted-foreground text-xs whitespace-nowrap">sells @ outside in ≥</span>
              <Input inputMode="decimal" className="h-8 w-16 font-mono text-xs" placeholder="–" value={r.sellAt} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, sellAt: e.target.value } : x)))} aria-label={`${prefix}${i + 1} sells at outside HYPE in`} />
              <span className="text-muted-foreground text-xs">{chain.symbol}</span>
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
  const tone = (e: LogEntry) => (e.level === "error" ? "text-destructive" : e.level === "warn" ? "text-warn" : e.level === "ok" ? "text-ok" : "")

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Launch on {LAUNCHPAD_NAMES[pad]}</h1>
          <p className="text-muted-foreground text-sm">One transaction on Elysium makes the coin, its pool and the dev buy; the moment it confirms, your bundle wallets buy at once and the auto-sell is armed. The image and metadata pin by themselves; when the coin is live, Trading opens on it.</p>
        </div>

        {/* ── the launchpad ── */}
        <Card className="gap-2">
          <h2 className="text-[15px] font-semibold">Launchpad</h2>
          <div className="flex flex-wrap gap-2">
            {[BRAND_PAD, ...LAUNCHPADS.filter((x) => x !== BRAND_PAD)].map((p) => (
              <button key={p} type="button" onClick={() => setPad(p)} disabled={launching} aria-pressed={pad === p} className={`flex min-w-44 flex-1 flex-col items-start gap-0.5 rounded-xl border-2 px-3 py-2 text-left transition-colors ${pad === p ? "border-ok bg-ok/5" : "hover:bg-accent"}`}>
                <span className={`text-sm font-bold tracking-wide uppercase ${pad === p ? "text-ok" : ""}`}>{LAUNCHPAD_NAMES[p]}</span>
                <span className="text-muted-foreground text-xs">{LAUNCHPAD_BLURB[p]}</span>
              </button>
            ))}
          </div>
        </Card>

        {/* ── the coin ── */}
        <Card className="gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold">Coin</h2>
            <Button size="sm" variant="outline" onClick={() => void autofill()} disabled={!!busy || launching} title="Fills every field with the trenchy.tools coin and loads our logo; default launch numbers">{busy === "autofill" ? "Filling…" : "Auto-fill demo data"}</Button>
          </div>
          <div className="flex items-start gap-4">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); const file = e.dataTransfer.files?.[0]; if (file) setImage(file) }}
              className={`flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border-2 border-dashed transition-colors ${dragOver ? "border-foreground bg-accent" : "hover:border-foreground/60"}`}
              title="Click or drop an image (png, jpg, gif, webp, up to 4 MB). It is uploaded to IPFS when you launch."
            >
              {preview ? <img src={preview} alt="" className="size-full object-cover" /> : <span className="text-muted-foreground flex flex-col items-center gap-1 text-[11px]"><ImagePlus className="size-5" />image</span>}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
            </button>
            <div className="grid flex-1 gap-3 sm:grid-cols-2">
              <Field label="Name"><Input maxLength={32} placeholder="My Coin" value={f.name} onChange={set("name")} /></Field>
              <Field label="Symbol"><Input maxLength={10} placeholder="COIN" value={f.symbol} onChange={(e) => setF((s) => ({ ...s, symbol: e.target.value.toUpperCase() }))} /></Field>
              <Field label="Description" className="sm:col-span-2"><Textarea className="min-h-14" placeholder="What is it?" value={f.description} onChange={set("description")} /></Field>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Input className="text-xs" placeholder="Twitter / X URL" value={f.twitter} onChange={set("twitter")} />
            <Input className="text-xs" placeholder="Telegram URL" value={f.telegram} onChange={set("telegram")} />
            <Input className="text-xs" placeholder="Website URL" value={f.website} onChange={set("website")} />
          </div>
        </Card>

        {/* ── the buys ── */}
        <Card className="gap-4">
          <h2 className="text-[15px] font-semibold">Buys</h2>
          <div className="border-ok/60 bg-ok/5 flex flex-col gap-2 rounded-xl border-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="bg-ok text-background rounded-md px-2 py-0.5 text-[11px] font-bold tracking-[0.15em] uppercase">Dev wallet</span>
              <span className="text-muted-foreground text-xs">creates the coin · pays every buyer · receives the dev bag · claims the creator fees</span>
            </div>
            {wallets.length ? (
              <div className="flex flex-wrap items-center gap-2">
                <Select className="h-9 max-w-md flex-1 text-sm font-medium" value={devWallet} onChange={(e) => setDevWallet(e.target.value)} aria-label="Dev wallet">
                  {[...wallets].sort((a, b) => (a.publicKey === main ? -1 : b.publicKey === main ? 1 : 0)).map((w) => <option key={w.publicKey} value={w.publicKey === main ? "" : w.publicKey}>{w.publicKey === main ? "★ " : ""}{w.label} · {chain.short(w.publicKey)} · {chain.fmt(balances.get(w.publicKey))} {chain.symbol}</option>)}
                </Select>
                <span className="font-mono text-sm font-semibold">{chain.fmt(dev ? balances.get(dev) : undefined)} {chain.symbol}</span>
                {devDesk ? <Pill tone="ok" title={devDesk}>desk {chain.short(devDesk)} · {pad === "ascend" ? "the dev bag lands in it" : "the dev bag is moved into it right after the launch"}, sells need no approval</Pill> : null}
                {dev && dev !== main ? <span className="text-warn text-xs">not the ★ wallet: ★ still funds the buyers</span> : null}
              </div>
            ) : (
              <span className="text-warn text-xs">No wallets yet. <Link href="/wallets" className="underline underline-offset-4">Create or import one on the Wallets page</Link>; the first one becomes ★ and is the dev wallet.</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Dev buy</span>
            <Input inputMode="decimal" className="h-8 w-24 font-mono text-xs" value={f.devBuyEth} onChange={set("devBuyEth")} aria-label="Dev buy" />
            <span className="text-muted-foreground text-xs">{chain.symbol}</span>
            {DEV_CHIPS.map((v) => <Chip key={v} active={f.devBuyEth === v} onClick={() => setF((s) => ({ ...s, devBuyEth: v }))}>{v}</Chip>)}
          </div>
          {pad === "ascend" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase" title="Fixed for ever at launch. Ascend's cut comes out of the first 1 %; everything above it is the creator's, claimable as it accrues. At 1 % the creator's share is held until the coin graduates.">Trade fee</span>
              {FEE_CHIPS.map(([v, label]) => <Chip key={v} active={f.feePpm === v} onClick={() => setF((s) => ({ ...s, feePpm: v }))}>{label}</Chip>)}
            </div>
          ) : pad === "boxa" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase" title="An EXTRA fee on top of BOXA's own hook cut, paid to you as the creator. 0 is what BOXA's own UI sends; up to 5 % is accepted (10 % is refused).">Extra fee</span>
              {BOXA_FEE_CHIPS.map(([v, label]) => <Chip key={v} active={f.feeBps === v} onClick={() => setF((s) => ({ ...s, feeBps: v }))}>{label}</Chip>)}
              <span className="text-muted-foreground text-xs">on top of the hook's own cut · yours, claimable from the hook as it accrues</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Trade fee</span>
              <span className="text-muted-foreground text-xs">Montra's hook sets it (not a launch parameter); the creator's share is claimable from the hook as it accrues</span>
            </div>
          )}
          <div className={`flex flex-col gap-2 rounded-lg border p-3 ${autoSell ? "border-warn/50" : ""}`}>
            <div className="flex flex-wrap items-center gap-3">
              <Toggle checked={autoSell} onChange={setAutoSell} label={<span className={`text-[11px] font-semibold tracking-wide uppercase ${autoSell ? "text-warn" : "text-muted-foreground"}`}>Auto-sell {autoSell ? "on" : "off"}</span>} />
              <span className="text-muted-foreground text-xs">{autoSell ? "armed the moment the coin exists: a sell pre-signed for every wallet that holds it, fired the instant a rule trips" : "nothing sells on its own; you sell by hand on the Trading page"}</span>
            </div>
            {autoSell ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-foreground font-medium">Sell everything</span>
                  <span className="text-muted-foreground">when net outside in reaches $</span>
                  <Input inputMode="decimal" className="h-8 w-16 font-mono text-xs" placeholder="off" value={f.exitUsd} onChange={set("exitUsd")} aria-label="Sell at dollars net in" />
                  <span className="text-muted-foreground">· or on the next outside buy ≥</span>
                  <Input inputMode="decimal" className="h-8 w-16 font-mono text-xs" placeholder="off" value={f.exitNext} onChange={set("exitNext")} aria-label="Next buy size" />
                  <span className="text-muted-foreground">{chain.symbol} (blank = off)</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-foreground font-medium">Dev wallet sells on its own</span>
                  <span className="text-muted-foreground">when outside {chain.symbol} in ≥</span>
                  <Input inputMode="decimal" className="h-8 w-16 font-mono text-xs" placeholder="–" value={f.devSellAt} onChange={set("devSellAt")} aria-label="Dev sells at outside HYPE in" />
                  <span className="text-muted-foreground">{chain.symbol} · every buyer row below has the same field</span>
                </div>
                <p className="text-muted-foreground text-xs"><span className="text-foreground font-medium">What "outside {chain.symbol} in" means:</span> the {chain.symbol} strangers have net-put into the coin since launch, i.e. their buys minus their sells. Our own wallets and desks never count, so our bundle and staggered buys cannot trip our own exits. Give each wallet its own bar and the exits ladder out: S1 at 1, S2 at 3, dev at 8 means S1's pre-signed sell goes out the moment outsiders have net-bought 1 {chain.symbol}, S2 keeps holding until 3, the dev until 8. The two "sell everything" rules above fire whatever is still held. A wallet with no bar only sells on those two.</p>
              </>
            ) : null}
          </div>
          <div className="grid gap-3">
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-ok text-[11px] font-semibold tracking-wide uppercase">Bundle buyers</span>
                <span className="text-muted-foreground text-xs">at once, the moment the launch confirms</span>
              </div>
              <p className="text-muted-foreground text-xs">Every bundle wallet buys the instant the launch confirms (up to 16), fired through every relay so they land in the next blocks. No gate: these buys are part of the launch. A buyer with a desk buys through it.</p>
              <div className="flex flex-wrap gap-1">{BUNDLE_COUNTS.map((c) => <Chip key={c} active={bundle.length === c} onClick={() => setBundle(resize(bundle, c, "0.05"))}>{c}</Chip>)}</div>
              <Rows rows={bundle} onChange={setBundle} prefix="B" />
            </div>
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-warn text-[11px] font-semibold tracking-wide uppercase">Staggered buyers</span>
                <span className="text-muted-foreground text-xs">one after another, only when outsiders are buying inside your range</span>
              </div>
              <p className="text-muted-foreground text-xs">After the launch these wallets buy one at a time. Before each buy the gate checks outsiders' net buying (their buys minus their sells, our wallets and desks excluded) over the last window: below the floor = nobody is here yet, wait; above the cap = bots are piling in, wait; inside = buy. A wallet that never gets a green light before its give-up time is skipped, and the whole run stops the moment one of our wallets sells.</p>
              <div className="flex flex-wrap gap-1">{HOLDER_COUNTS.map((c) => <Chip key={c} active={holders.length === c} onClick={() => setHolders(resize(holders, c, "0.05"))}>{c}</Chip>)}</div>
              <Rows rows={holders} onChange={setHolders} prefix="S" />
              {holders.length ? (
                <div className="flex flex-col gap-2 rounded-md border border-dashed p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground">first buy</span>
                    <Input inputMode="decimal" className="h-7 w-14 font-mono text-xs" value={st.startDelayS} onChange={setSt1("startDelayS")} aria-label="Start delay seconds" />
                    <span className="text-muted-foreground">s after the launch · then</span>
                    <Input inputMode="decimal" className="h-7 w-14 font-mono text-xs" value={st.gapMinS} onChange={setSt1("gapMinS")} aria-label="Minimum gap seconds" />
                    <span className="text-muted-foreground">–</span>
                    <Input inputMode="decimal" className="h-7 w-14 font-mono text-xs" value={st.gapMaxS} onChange={setSt1("gapMaxS")} aria-label="Maximum gap seconds" />
                    <span className="text-muted-foreground">s between buys (random)</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-foreground font-medium">Buy only when</span>
                    <span className="text-muted-foreground">outsiders' net buying in the last</span>
                    <Input inputMode="decimal" className="h-7 w-14 font-mono text-xs" value={st.windowS} onChange={setSt1("windowS")} aria-label="Window seconds" />
                    <span className="text-muted-foreground">s is between</span>
                    <Input inputMode="decimal" className="h-7 w-16 font-mono text-xs" value={st.minHype} onChange={setSt1("minHype")} aria-label="Outside flow floor" />
                    <span className="text-muted-foreground">and</span>
                    <Input inputMode="decimal" className="h-7 w-16 font-mono text-xs" value={st.maxHype} onChange={setSt1("maxHype")} aria-label="Outside flow cap" />
                    <span className="text-muted-foreground">{chain.symbol} (0 = no floor / no cap)</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground">give up on a wallet after</span>
                    <Input inputMode="decimal" className="h-7 w-14 font-mono text-xs" value={st.giveUpMin} onChange={setSt1("giveUpMin")} aria-label="Give up minutes" />
                    <span className="text-muted-foreground">min outside the range</span>
                    <span className="text-muted-foreground">·</span>
                    <Toggle checked={st.stopOnOwnSell} onChange={(v) => setSt((s) => ({ ...s, stopOnOwnSell: v }))} label="stop the run if any of our wallets sells (auto-sell fired)" />
                  </div>
                  <p className="text-muted-foreground">{n(st.minHype) > 0 || n(st.maxHype) > 0 ? `Rule: buy when outsiders' net in the last ${n(st.windowS, 60)}s is ${n(st.minHype) > 0 && n(st.maxHype) > 0 ? `${n(st.minHype)}–${n(st.maxHype)}` : n(st.minHype) > 0 ? `at least ${n(st.minHype)}` : `at most ${n(st.maxHype)}`} ${chain.symbol}; otherwise wait, re-checking every 2 s.` : "No floor and no cap: every wallet buys on its turn, nothing is checked."}</p>
                </div>
              ) : null}
            </div>
          </div>
          <p className="text-muted-foreground text-xs"><span className="text-foreground font-medium">How the buyers get their money:</span> a "new wallet" row is created when you press Launch (its key is saved {DEMO ? "in this browser, the backup downloads itself" : "to the folder"} first), then the ★ wallet sends every buyer its buy + 0.002 HYPE for gas, and only then the coin is created. So ★ must hold the Cost total on the right. Pick an existing wallet in a row to use one that is already funded.</p>
        </Card>

        {/* ── advanced ── */}
        <Button variant="outline" size="lg" className="h-auto w-full justify-between px-4 py-3 text-left" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2 font-semibold"><SlidersHorizontal className="size-4" /> Advanced options</span>
            <span className="text-muted-foreground truncate text-xs font-normal">{advanced ? "slippage · funding" : `${fundFirst ? "★ funds the buyers" : "no funding"}${f.slippage ? ` · slippage ${f.slippage} %` : " · slippage from Settings"}`}</span>
          </span>
          <span className="shrink-0 text-base">{advanced ? "▴" : "▾"}</span>
        </Button>
        {advanced ? (
          <Card className="gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Slippage % (blank = Settings)"><Input inputMode="numeric" value={f.slippage} onChange={set("slippage")} /></Field>
            </div>
            <Toggle checked={fundFirst} onChange={setFundFirst} label="Top short buyers up from ★ before the create (off: refuse when a wallet is short)" />
          </Card>
        ) : null}

        <FailureBox failure={failure} />
        <div className="flex gap-3">
          <Button variant="secondary" size="lg" className="flex-1" onClick={simulate} disabled={!!busy || launching || !main} title="Builds the launch and runs every transaction through eth_call on the live chain. Every chain call is listed on the right. Nothing is sent.">{busy === "simulate" ? "Dry run…" : "Dry run · see every chain call"}</Button>
          <Button size="lg" className={`flex-[2] ${short ? "bg-destructive hover:bg-destructive/90 text-white" : ""}`} onClick={launch} disabled={!!busy || launching || !!blocker}>
            {busy === "launch" ? "Starting…" : launching ? "Launching…" : blocker ?? `Launch (${plan ? eth(plan.totalEth) : "…"} ${chain.symbol})`}
          </Button>
        </div>
        {DEMO ? <p className="text-muted-foreground -mt-2 text-xs">{TAB_NOTE}</p> : null}
      </div>

      {/* ── right: cost, simulation, the run ── */}
      <div className="flex flex-col gap-4">
        <Card className="gap-2">
          <h2 className="text-[15px] font-semibold">Cost</h2>
          {plan ? (
            <>
              <div className="flex flex-col gap-1 text-sm">
                {plan.rows.map((r, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground truncate text-xs">{r.role === "dev" ? "Dev" : r.label} <span className="opacity-70">(buy {eth(r.buyEth)}{r.publicKey ? `, has ${eth(r.haveEth)}` : ""})</span></span>
                    <Mono className={`text-xs ${r.shortEth ? "text-warn" : ""}`}>{eth(r.needEth)}</Mono>
                  </div>
                ))}
                <div className="mt-1 flex items-baseline justify-between border-t pt-2 font-medium"><span>Total across the wallets</span><Mono>{eth(plan.totalEth)} {chain.symbol}</Mono></div>
                <div className="text-muted-foreground flex justify-between text-xs"><span>{fundFirst ? "★ sends at launch (the shortfall)" : "Short (funding is off)"}</span><Mono className={`text-xs ${short ? "text-destructive" : ""}`}>{eth(plan.shortEth ?? 0)} {chain.symbol}</Mono></div>
              </div>
              {plan.warnings.map((w, i) => <p key={i} className="text-warn text-xs">{w}</p>)}
              <p className="text-muted-foreground text-xs">buy + 0.002 {chain.symbol} gas per wallet, the dev's launch {LAUNCH_GAS_TEXT[pad]} gas · no creation fee · ★ holds {mainBalance === undefined ? "…" : `${eth(mainBalance)} ${chain.symbol}`}</p>
            </>
          ) : <p className="text-muted-foreground text-sm">…</p>}
        </Card>

        <Card className="gap-2">
          <ApiCalls calls={sim?.calls} title="Dry run · the chain calls" empty="Press Dry run: every call this app makes to the chain shows here with what came back. Nothing is sent." />
        </Card>

        {sim ? (
          <Card className="gap-2">
            <h2 className={`text-[15px] font-semibold ${sim.simulation.ok ? "text-ok" : "text-warn"}`}>{sim.simulation.ok ? "Dry run passed" : "Dry run failed"}</h2>
            {sim.predicted ? <p className="text-muted-foreground text-xs">{sim.predicted.token ? <>The coin will be <Mono className="text-xs">{sim.predicted.token}</Mono> · </> : null}Dev bag goes to <Mono className="text-xs">{sim.predicted.devReceiver}</Mono>{sim.predicted.devReceiver?.toLowerCase() !== (dev ?? "").toLowerCase() ? " (its desk)" : pad === "ascend" ? " (the wallet; deploy a desk on the Trading page for approval-free sells)" : " (the wallet; moved into its v2 desk right after the launch when it has one)"} · dev buy {sim.expected.eth} {chain.symbol} · no creation fee. Nothing was sent.</p> : null}
            <ul className="flex flex-col gap-1 text-xs">
              {sim.simulation.steps.map((s, i) => <li key={i} className="flex gap-2"><span className={s.ok ? "text-ok" : "text-destructive"}>{s.ok ? "✓" : "✗"}</span><span className="text-muted-foreground w-16 shrink-0">{s.label}</span><span className="break-all">{s.ok ? `gas ${s.gasUsed}` : s.error}</span></li>)}
            </ul>
          </Card>
        ) : null}

        {log.length || launchId ? (
          <Card className={`gap-2 ${done === "error" ? "border-destructive/40" : done === "live" ? "border-ok/40" : ""}`}>
            <div className="flex items-center justify-between">
              <h2 className={`text-[15px] font-semibold ${done === "error" ? "text-destructive" : done === "live" ? "text-ok" : ""}`}>{done === "error" ? "Launch failed" : done === "live" ? "Live — opening Trading…" : "Launching…"}</h2>
              {done ? <Pill tone={done === "live" ? "ok" : "error"}>{done}</Pill> : null}
            </div>
            <div ref={logRef} className="flex max-h-80 flex-col gap-1 overflow-y-auto text-xs">
              {log.map((e, i) => (
                <div key={i} className={`flex gap-2 ${tone(e)}`}>
                  <Mono className="text-muted-foreground w-16 shrink-0 text-[11px]">{e.stage}</Mono>
                  <span className="break-words">{e.msg}{e.hash ? <> <a className="underline underline-offset-4" href={chain.explorerTx(e.hash)} target="_blank" rel="noreferrer">tx</a></> : null}</span>
                </div>
              ))}
              {launching ? <span className="text-muted-foreground">…</span> : null}
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  )
}

/** POST a FormData to one of the app's routes (lib/api's post() is JSON-only). */
async function fetchApp(path: string, body: FormData): Promise<{ image: string; metadataUri: string }> {
  const { appFetch } = await import("@/lib/browser/demo")
  const res = await appFetch(path, { method: "POST", body })
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(text) as Record<string, unknown> } catch { /* not JSON */ }
  if (!res.ok) throw { ...data, error: String(data.error ?? `HTTP ${res.status}`), status: res.status }
  return data as { image: string; metadataUri: string }
}
