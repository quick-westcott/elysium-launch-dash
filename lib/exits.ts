/**
 * The auto-sell on the server: the shared watcher (lib/core/exits.ts) over the wallet folder. Rules live in
 * `_app/elysium-starter/exits.json`, so a server restart re-arms them.
 */
import "./paths" // registers the record files (lib/kv.ts)
import { createExits } from "./core/exits"
import { chainApi } from "./settings"
import { walletStore } from "./wallets"
import { appState } from "./state"

export type { ExitRule } from "./core/exits"
export { CHAIN_ID, fmtHype, toWei } from "./core/exits"

const exits = appState("exitsEngine", () => {
  const e = createExits({ api: chainApi, wallets: walletStore })
  e.resumeExits()
  return e
})
export const { armExit, cancelExit, fireExit, listExits, resumeExits } = exits
