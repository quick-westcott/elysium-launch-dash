/**
 * Settings: `_app/elysium-starter/settings.json` in the wallet folder (written by the Settings sheet) over `.env`.
 *   slippage    (percent)            default 10
 *   sniperGapMs                      default 400 (gap between sniper buys after the create confirms)
 *   holderWindowS / holderDelayS     default 120 / 5 (holder buys spread over the window, after the delay)
 *   feePpm                           the pool's trade fee at launch, hundredths of a bip (10000 = 1 %)
 *   mainWallet                       the ★ wallet (0x address): pays for everything, receives gathers, default creator
 * No API key: this app talks to the chain itself (lib/elysium/chain.ts).
 */
import { DEFAULTS } from "./core/env"
import { SETTINGS_FILE, readJson, writeJson } from "./paths"
import { ElysiumApi } from "./elysium/api"

export type Settings = { slippage?: number; sniperGapMs?: number; holderWindowS?: number; holderDelayS?: number; feePpm?: number; mainWallet?: string }
const NUMS = ["slippage", "sniperGapMs", "holderWindowS", "holderDelayS", "feePpm"] as const

export function readSettings(): Settings {
  const raw = readJson<Settings>(SETTINGS_FILE, {})
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined)
  const out: Settings = { mainWallet: str(raw.mainWallet) }
  for (const k of NUMS) out[k] = num(raw[k])
  return out
}

/** A field left undefined keeps its value; null or "" clears it (back to the default). */
export function updateSettings(patch: { [K in keyof Settings]?: Settings[K] | null }): Settings {
  const next: Settings = { ...readSettings() }
  if (patch.mainWallet !== undefined) {
    const v = typeof patch.mainWallet === "string" ? patch.mainWallet.trim() : ""
    if (v) next.mainWallet = v
    else delete next.mainWallet
  }
  for (const k of NUMS) {
    if (patch[k] === undefined) continue
    const v = patch[k]
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) next[k] = v
    else delete next[k]
  }
  writeJson(SETTINGS_FILE, next)
  return next
}

export type Effective = { slippage: number; sniperGapMs: number; holderWindowS: number; holderDelayS: number; feePpm: number }

/** What the app actually uses: settings.json over the built-in default. */
export function effectiveSettings(): Effective {
  const s = readSettings()
  return {
    slippage: s.slippage ?? DEFAULTS.slippage,
    sniperGapMs: s.sniperGapMs ?? DEFAULTS.sniperGapMs,
    holderWindowS: s.holderWindowS ?? DEFAULTS.holderWindowS,
    holderDelayS: s.holderDelayS ?? DEFAULTS.holderDelayS,
    feePpm: s.feePpm && s.feePpm >= 10_000 && s.feePpm <= 100_000 ? s.feePpm : 10_000,
  }
}

const one = new ElysiumApi()
/** The chain client. One for the process. */
export function chainApi(): ElysiumApi {
  return one
}
/** Kept under its old name for the routes that still say it. */
export const trenchy = chainApi
