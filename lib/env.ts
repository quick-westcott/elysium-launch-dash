/**
 * The Env (lib/core/env.ts) of this server: the wallet folder, launches.json and the settings, with the chain client.
 */
import type { Env, LaunchRecord } from "./core/launch"
import { LAUNCHES_FILE, readJson, writeJson } from "./paths"
import { chainApi, effectiveSettings } from "./settings"
import { walletStore } from "./wallets"
import { outsideNet, ownSells } from "./trading"

/** launches.json in _app/elysium-starter/, newest first (at most 200). */
export const readLaunches = (): LaunchRecord[] => readJson<LaunchRecord[]>(LAUNCHES_FILE, [])
export function saveLaunch(rec: LaunchRecord): void {
  const all = readLaunches().filter((l) => l.id !== rec.id)
  all.unshift(rec)
  writeJson(LAUNCHES_FILE, all.slice(0, 200))
}

/** The Env with the current settings. Cheap: build one per request. */
export function serverEnv(): Env {
  const s = effectiveSettings()
  return {
    api: chainApi(),
    wallets: walletStore,
    launches: { list: readLaunches, save: saveLaunch },
    flow: { outsideNet, ownSells },
    slippage: s.slippage,
    sniperGapMs: s.sniperGapMs,
    holderWindowS: s.holderWindowS,
    holderDelayS: s.holderDelayS,
    feePpm: s.feePpm,
  }
}
