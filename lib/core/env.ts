/**
 * What the shared flows (lib/core/launch.ts, trading.ts, funding.ts) need from the outside world, as one object:
 * the chain client, the wallet folder, the launch records and the timing settings. Every store method is
 * synchronous on purpose (fs sync calls). No node imports.
 */
import type { PrivateKeyAccount } from "viem/accounts"
import type { ElysiumApi } from "../elysium/api"
import type { Role, WalletInfo } from "./wallet-record"

export type WalletStore = {
  place: "folder" | "browser"
  /** every usable wallet (not archived), oldest first; `role` filters by the tag */
  list(role?: Role): WalletInfo[]
  /** a usable wallet by address (any letter case), or null */
  get(publicKey: string): WalletInfo | null
  /** the ★ wallet: pays for everything, receives gathers, is the default creator */
  main(): WalletInfo | null
  /** the backup rule: throws NotBackedUpError unless the key is safely backed up */
  assertBackedUp(publicKey: string): void
  /** the viem account that signs; throws NotBackedUpError when the wallet is unknown or not backed up */
  accountOf(publicKey: string): PrivateKeyAccount
  /** the private keys of these wallets, for a seal or an export (local mode: the files; browser: storage) */
  secrets(publicKeys: string[]): Array<{ publicKey: string; privateKey: string; label: string }>
  /** create (and store) `count` wallets; the first wallet ever becomes ★ */
  create(count: number, role?: Role, label?: string): WalletInfo[]
}

/**
 * What the staggered buys read off the coin's tape: outsiders' net buying over a window (buys − sells by wallets
 * that are not ours, our desks included as ours), and whether any of OUR wallets has sold since a moment (the
 * auto-sell fired, or the operator pressed sell: a stagger must stop buying a coin we are leaving).
 */
export type FlowReader = {
  outsideNet(token: string, windowMs: number): { net: number; inHype: number; outHype: number; buys: number; sells: number }
  ownSells(token: string, sinceMs: number): number
}

export type Env<LaunchRecord = unknown> = {
  api: ElysiumApi
  wallets: WalletStore
  /** the coin's tape, for the gated buys; absent = every gate passes (and the log says so) */
  flow?: FlowReader
  /** launch records, newest first */
  launches: { list(): LaunchRecord[]; save(rec: LaunchRecord): void }
  /** percent, the default of every trade and launch */
  slippage: number
  /** the gap between sniper buys after the create confirms */
  sniperGapMs: number
  /** holder buys are spread over the window, after the delay */
  holderWindowS: number
  holderDelayS: number
  /** the pool's trade fee a launch sets, hundredths of a bip */
  feePpm: number
}

export const where = (_w: WalletStore) => "in the folder"

/** Defaults when settings.json says nothing. */
export const DEFAULTS = { slippage: 10, sniperGapMs: 400, holderWindowS: 120, holderDelayS: 5, feePpm: 10_000 }
