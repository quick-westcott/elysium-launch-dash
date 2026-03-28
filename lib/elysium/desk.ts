/**
 * The desk: one small contract per wallet (contracts/ElysiumDesk.sol) that holds HYPE and trades Ascend's V4 pools
 * straight against the PoolManager. No ERC-20 approve, no Permit2, no router, no wrap: a sell is one ~96k-gas call,
 * a buy ~220k, and the coin sits inside the desk between the two. Proven by eth_call code override on live pools and
 * by a real round trip (11/5). HYPE pairs only: the desk wraps and unwraps WHYPE itself.
 *
 * Which wallet owns which desk is kept in `_app/elysium-starter/desks.json` (lib/paths.ts).
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem"
import { ADDR, publicClient } from "./chain"
import { ELYSIUM_DESK_BYTECODE, ELYSIUM_DESK_VERSION } from "./desk-bytecode"
import { ascendKey, ERC20_ABI, type PoolKey } from "./v4"
import { venueCached } from "./pads"
import { appState } from "../state"
import { kv } from "../kv"

export const DESK_ABI = parseAbi([
  "function owner() view returns (address)",
  "function version() view returns (uint8)",
  "function buy((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint256 hypeIn, uint256 minOut) returns (uint256 out)",
  "function sell((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint256 amountIn, uint256 minOut) returns (uint256 out)",
  "function withdrawHype(address to, uint256 amount)",
  "function withdrawToken(address token, address to, uint256 amount)",
  "event Traded(address indexed token, bool indexed buy, uint256 amountIn, uint256 amountOut)",
  "error NotOwner()", "error NotPoolManager()", "error Slippage(uint256 out, uint256 minOut)", "error NothingToSell()", "error TransferFailed()",
])
export const DESK_DEPLOY_GAS = 1_200_000n
export const DESK_BUY_GAS = 400_000n
export const DESK_SELL_GAS = 250_000n
export { ELYSIUM_DESK_BYTECODE as DESK_BYTECODE, ELYSIUM_DESK_VERSION as DESK_VERSION }

/**
 * The pool key the desk trades for `token`: a Montra / BOXA coin's native-HYPE key when the venue cache has resolved
 * one (lib/elysium/pads.ts — every build resolves the venue first, so it is warm), else Ascend's WHYPE key.
 */
export function deskKeyFor(token: Address): PoolKey {
  const hit = venueCached(token)
  if (hit && hit.venue !== "ascend") return { ...hit.key }
  return { ...ascendKey(token).key, hooks: ADDR.launchpad }
}

const versionCache = appState("deskVersions", () => new Map<string, number>())
/** 2 for a v2 desk (native-HYPE pools too), 1 for one deployed before version() existed. Remembered per desk. */
export async function deskVersion(desk: Address): Promise<number> {
  const k = desk.toLowerCase()
  const hit = versionCache.get(k)
  if (hit) return hit
  const v = await publicClient().readContract({ address: desk, abi: DESK_ABI, functionName: "version" }).then(Number).catch(() => 1)
  versionCache.set(k, v)
  return v
}
export const rememberDeskVersion = (desk: Address, v: number) => versionCache.set(desk.toLowerCase(), v)

/** Can this desk trade `token`? Ascend coins: any desk. Montra / BOXA coins (native pools on the main PoolManager): a v2 desk. */
export async function deskSupports(desk: Address, token: Address): Promise<boolean> {
  const hit = venueCached(token)
  if (!hit || hit.venue === "ascend") return true
  return (await deskVersion(desk)) >= ELYSIUM_DESK_VERSION
}

export const deskBuyData = (token: Address, hypeIn: bigint, minOut: bigint): Hex => encodeFunctionData({ abi: DESK_ABI, functionName: "buy", args: [deskKeyFor(token), hypeIn, minOut] })
/** amountIn 0 = everything the desk holds. */
export const deskSellData = (token: Address, amountIn: bigint, minOut: bigint): Hex => encodeFunctionData({ abi: DESK_ABI, functionName: "sell", args: [deskKeyFor(token), amountIn, minOut] })
export const deskWithdrawHypeData = (to: Address, wei: bigint): Hex => encodeFunctionData({ abi: DESK_ABI, functionName: "withdrawHype", args: [to, wei] })
export const deskWithdrawTokenData = (token: Address, to: Address, wei: bigint): Hex => encodeFunctionData({ abi: DESK_ABI, functionName: "withdrawToken", args: [token, to, wei] })

// ── the registry ──────────────────────────────────────────────────────────────

// which wallet owns which desk: desks.json on the server, localStorage in demo mode (lib/kv.ts)
const read = (): Record<string, Address> => kv().read<Record<string, Address>>("desks", {})
export const deskOf = (wallet: string): Address | null => read()[wallet.toLowerCase()] ?? null
export const allDesks = (): Record<string, Address> => read()
export function rememberDesk(wallet: string, desk: Address): void {
  const all = read()
  all[wallet.toLowerCase()] = desk
  kv().write("desks", all)
}
export function forgetDesk(wallet: string): void {
  const all = read()
  delete all[wallet.toLowerCase()]
  kv().write("desks", all)
}

export type DeskView = { desk: Address; owner: Address; hypeWei: bigint; tokenWei: bigint }

export async function deskView(desk: Address, token?: Address | null): Promise<DeskView> {
  const c = publicClient()
  const [owner, hypeWei, tokenWei] = await Promise.all([
    c.readContract({ address: desk, abi: DESK_ABI, functionName: "owner" }),
    c.getBalance({ address: desk }),
    token ? c.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [desk] }) : Promise.resolve(0n),
  ])
  return { desk, owner, hypeWei, tokenWei }
}

/** The remembered desk, confirmed to exist and to be owned by the wallet; forgotten otherwise. */
export async function verifyDesk(wallet: string): Promise<Address | null> {
  const desk = deskOf(wallet)
  if (!desk) return null
  try {
    const code = await publicClient().getCode({ address: desk })
    if (!code || code === "0x") { forgetDesk(wallet); return null }
    const v = await deskView(desk)
    if (v.owner.toLowerCase() !== wallet.toLowerCase()) { forgetDesk(wallet); return null }
    return desk
  } catch {
    return desk
  }
}

/** What the wallet's desk holds of `token` (0 without a desk). */
export async function deskHolding(wallet: string, token: Address): Promise<{ desk: Address; held: bigint } | null> {
  const desk = deskOf(wallet)
  if (!desk) return null
  const held = await publicClient().readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [desk] }).catch(() => 0n)
  return { desk, held }
}
