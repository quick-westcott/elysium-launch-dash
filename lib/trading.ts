/**
 * Trading after the launch: the flows in lib/core/trading.ts run on the wallet folder (lib/env.ts). Live trades are
 * read off the chain (lib/elysium/tape.ts) by a 600 ms poller per followed coin, held in server memory and relayed
 * to the page as server-sent events.
 */
import * as core from "./core/trading"
import { serverEnv } from "./env"
import "./paths"
import { appState } from "./state"
import { createFeed } from "./core/feed"
import { listWallets } from "./wallets"
import type { LiveTrade, SellAllResult, TradeResult } from "./core/trading"

export type { Holding, LiveTrade, SellAllResult, TradeResult } from "./core/trading"

export const holdings = (token: string) => core.holdings(serverEnv(), token)
export const balanceRows = (token?: string | null) => core.balanceRows(serverEnv(), token)
export const sell = (publicKey: string, token: string, percent: number, slippage?: number): Promise<TradeResult> => core.sell(serverEnv(), publicKey, token, percent, slippage)
export const buy = (publicKey: string, token: string, eth: number, slippage?: number): Promise<TradeResult> => core.buy(serverEnv(), publicKey, token, eth, slippage)
export const sellAll = (publicKeys: string[], token: string, percent: number): Promise<SellAllResult> => core.sellAll(serverEnv(), publicKeys, token, percent)
export const creatorOf = (token: string) => core.creatorOf(serverEnv(), token)
export const creatorFees = (token: string) => core.creatorFees(serverEnv(), token)
export const collectCreatorFees = (token: string) => core.collectCreatorFees(serverEnv(), token)

// ── live trades: the shared feed (lib/core/feed.ts) over the wallet folder ─────────

const feed = appState("feedEngine", () => createFeed({ wallets: () => listWallets() }))
export const { backfillToken, followToken, outsideNet, ownSells, onTrade } = feed
