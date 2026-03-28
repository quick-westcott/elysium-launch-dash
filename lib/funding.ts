/**
 * Moving HYPE between the folder's wallets: the flows in lib/core/funding.ts run on the wallet folder (lib/env.ts).
 * All refuse a wallet whose file is missing. Plain transfers only: there is no exchange hop on Elysium.
 */
import * as core from "./core/funding"
import { serverEnv } from "./env"

export { GATHER_RESERVE_ETH } from "./core/funding"
export type { FundResult } from "./core/funding"

export const fundDirect = (targets: Array<{ publicKey: string; eth: number }>) => core.fundDirect(serverEnv(), targets)
export const gather = (publicKeys: string[]) => core.gather(serverEnv(), publicKeys)
export const sendDirect = (publicKeys: string[], to: string, amount: number | "max") => core.sendDirect(serverEnv(), publicKeys, to, amount)
