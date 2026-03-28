/**
 * The other two launchpads this app trades and launches on besides Ascend: MONTRA and BOXA. Ported from the launcher
 * (every address read off the chain 2026-11-05 and checked by eth_call against live pools; nothing is guessed) and
 * verified again on the TrenchyTools API against real coins.
 *
 *  - MONTRA (montramarkets.xyz): factory 0x38D3…cD15 launches a 1B coin into a native-HYPE pool on the MAIN
 *    PoolManager: (native HYPE, coin, dynamic fee 0x800000, spacing 200, hook 0x6b12…f8ec). Plain router swaps work
 *    and the main quoter quotes it. The hook pays the creator: claim(poolId, to), creator-only.
 *  - BOXA (boxa.club): launcher v2 0x5da7…03ed with hook 0x10f1…2aec on the MAIN PoolManager: (native HYPE, coin,
 *    fee 0, spacing 200); older coins sit behind hook v1 0x00c0…2acc with the same key shape, so both are tried. The
 *    hook pays creators: claimable(token, creator) / claim(token, to).
 *
 * Both quote native HYPE with the coin as currency1 (address 0 sorts first), so a pad coin is found by hashing its
 * known key and reading slot0: one call per candidate key, no log scans. Trading goes through the main
 * UniversalRouter + V4Quoter (lib/elysium/v4.ts v4ExactInCall / quoteKey), sells pulled through Permit2 like Ascend's.
 *
 * THE VENUE CACHE. Which market a coin trades on is resolved once (Ascend's pool first, then the pads) and kept in
 * server memory, seeded straight from our own launch receipts. The desk reads it to pick the pool key it trades
 * (lib/elysium/desk.ts), the tape reads it to know which Swap logs to follow. Only hits are cached: a coin that is
 * not found yet (a launch landing this second) is probed again next time. Server-side only.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem"
import { ADDR, publicClient } from "./chain"
import { ascendKey, poolExists, poolIdOf, quoteKey, sellApprovals, v4ExactInCall, type Call, type PoolKey } from "./v4"
import { appState } from "../state"

import { isLaunchpad, LAUNCHPAD_NAMES, LAUNCHPADS, type ElysiumPad, type Launchpad } from "../chain"

export { isLaunchpad, LAUNCHPAD_NAMES, LAUNCHPADS }
export type { ElysiumPad, Launchpad }
export const ELYSIUM_PADS: readonly ElysiumPad[] = ["montra", "boxa"]
export const isPad = (s: unknown): s is ElysiumPad => typeof s === "string" && (ELYSIUM_PADS as readonly string[]).includes(s)

const ZERO: Address = "0x0000000000000000000000000000000000000000"
/** The dynamic-fee flag (the same one Ascend pools carry). */
const DYNAMIC_FEE = 0x800000

export const MONTRA = {
  factory: "0x38D3ef3A06D18fA3286Fb5dEAfe611be725fcD15" as Address,
  hook: "0x6b1216a40b65c83e9c9e18a562c446697b8cf8ec" as Address,
  fee: DYNAMIC_FEE, tickSpacing: 200,
} as const
export const BOXA = {
  launcher: "0x5da7caf3bf626802f5348dde0db9dc02c72a03ed" as Address,
  hook: "0x10f11002b148be522005f9b5d666bef339392aec" as Address,
  /** The first launcher's hook (coins launched before 11/5 PM): same key shape, same claim surface. */
  hookV1: "0x00c002cdae688f39a90cf2ad74c59421c9502acc" as Address,
  fee: 0, tickSpacing: 200,
} as const

/** The pool key a pad coin has: native HYPE as currency0, the coin as currency1, the pad's fee/spacing/hook. */
export function padKey(pad: ElysiumPad, token: Address): PoolKey {
  return pad === "montra"
    ? { currency0: ZERO, currency1: token, fee: MONTRA.fee, tickSpacing: MONTRA.tickSpacing, hooks: MONTRA.hook }
    : { currency0: ZERO, currency1: token, fee: BOXA.fee, tickSpacing: BOXA.tickSpacing, hooks: BOXA.hook }
}
/** Every key a pad coin may have been initialised with: BOXA's two hooks (v2 then v1), one key for Montra. */
export function padKeys(pad: ElysiumPad, token: Address): PoolKey[] {
  if (pad === "boxa") return [padKey("boxa", token), { currency0: ZERO, currency1: token, fee: BOXA.fee, tickSpacing: BOXA.tickSpacing, hooks: BOXA.hookV1 }]
  return [padKey("montra", token)]
}

export type PadPool = { pad: ElysiumPad; poolId: Hex; key: PoolKey }

/** The pad pool for `token`, or null. One slot0 read per candidate key on the main PoolManager; throws when the RPC could not be asked. */
export async function padPoolFor(pad: ElysiumPad, token: Address): Promise<PadPool | null> {
  for (const key of padKeys(pad, token)) {
    const poolId = poolIdOf(key)
    if (await poolExists(poolId)) return { pad, poolId, key }
  }
  return null
}

/** Which pad a coin is on (Montra, then BOXA's two hooks), or null. The three slot0 reads run in parallel. */
export async function detectPad(token: Address): Promise<PadPool | null> {
  const candidates = ELYSIUM_PADS.flatMap((pad) => padKeys(pad, token).map((key) => ({ pad, key, poolId: poolIdOf(key) })))
  const found = await Promise.all(candidates.map(async (c) => ((await poolExists(c.poolId)) ? c : null)))
  return found.find((c): c is NonNullable<typeof c> => c !== null) ?? null
}

// ── the venue cache ───────────────────────────────────────────────────────────

export type Venue = Launchpad
export type VenueHit = { venue: Venue; pad?: ElysiumPad; poolId: Hex; key: PoolKey; /** always the main PoolManager for these three */ poolManager: Address; tokenIsCurrency0: boolean }

const venues = appState("venues", () => new Map<string, VenueHit>())

export const venueCached = (token: string): VenueHit | null => venues.get(token.toLowerCase()) ?? null
export function seedVenue(token: string, hit: VenueHit): void { venues.set(token.toLowerCase(), hit) }
export function forgetVenue(token: string): void { venues.delete(token.toLowerCase()) }

export function ascendHit(token: Address): VenueHit {
  const { key, tokenIsCurrency0 } = ascendKey(token)
  return { venue: "ascend", poolId: poolIdOf(key), key, poolManager: ADDR.poolManager, tokenIsCurrency0 }
}
export function padHit(pool: PadPool): VenueHit {
  return { venue: pool.pad, pad: pool.pad, poolId: pool.poolId, key: pool.key, poolManager: ADDR.poolManager, tokenIsCurrency0: false }
}
/** Seed a pad coin we launched ourselves (its key is known, no probe needed). */
export function seedPadVenue(pad: ElysiumPad, token: Address, key: PoolKey = padKey(pad, token)): VenueHit {
  const hit = padHit({ pad, poolId: poolIdOf(key), key })
  seedVenue(token, hit)
  return hit
}

/**
 * Which market a coin trades on: the cache, else Ascend's pool (the common case) and the pads probed together.
 * Null when none of the three has a pool for it (not launched on any of them, or the launch is not mined yet).
 */
export async function resolveVenue(token: Address): Promise<VenueHit | null> {
  const hit = venueCached(token)
  if (hit) return hit
  const a = ascendHit(token)
  const [onAscend, pad] = await Promise.all([poolExists(a.poolId).catch(() => false), detectPad(token).catch(() => null)])
  const v = onAscend ? a : pad ? padHit(pad) : null
  if (v) seedVenue(token, v)
  return v
}

export const venueLabel = (v: Venue | "none") => (v === "none" ? "no market found" : LAUNCHPAD_NAMES[v])

// ── trading a pad pool ────────────────────────────────────────────────────────

/** Gas limits for a pad swap (launcher's measured figures, with headroom): Montra buy ~222k, BOXA ~206k. */
export const PAD_SWAP_GAS = 450_000n

/** Tokens a buy of `amount` HYPE returns / HYPE a sell of `amount` tokens returns. Null when the pool/hook refuses. */
export function padQuote(hit: VenueHit, action: "buy" | "sell", amount: bigint): Promise<bigint | null> {
  return quoteKey(hit.key, action === "buy", amount)   // currency0 = native, so a buy is zeroForOne
}
/** HYPE → coin on a pad pool (native value sent), through the main UniversalRouter. */
export const padBuyCall = (hit: VenueHit, hypeIn: bigint, minOut: bigint): Call => v4ExactInCall(hit.key, true, hypeIn, minOut)
/** coin → HYPE on a pad pool; the coin is pulled through Permit2, so `padSellApprovals` go first. */
export const padSellCall = (hit: VenueHit, amountIn: bigint, minOut: bigint): Call => v4ExactInCall(hit.key, false, amountIn, minOut)
/** The approvals a pad sell still needs (token→Permit2, Permit2(token→main router)): the same two Ascend's sells use. */
export const padSellApprovals = (owner: Address, token: Address): Promise<Call[]> => sellApprovals(owner, token)

// ── creator fees ──────────────────────────────────────────────────────────────
// BOXA: the pool's own hook (v2 or v1, from detection) keeps claimable(token, creator) and pays with claim(token, to).
// Montra: its hook pays the creator with claim(poolId, to), creator-only (a stranger reverts 0x586d3357) and returns
// the amount — simulated from the creator to show it.

export const BOXA_HOOK_ABI = parseAbi([
  "function extraCutBps() view returns (uint16)",
  "function claimable(address pair, address payee) view returns (uint256)",
  "function claim(address pair, address recipient) returns (uint256)",
])
export const MONTRA_HOOK_FEES_ABI = parseAbi([
  "function claim(bytes32 poolId, address to) returns (uint256 amount)",
])

export type PadFeeView = { pad: ElysiumPad; /** the contract that pays: the pool's hook */ payer: Address; claimableWei: bigint }

/** What a pad creator can claim now, in wei (0 when the hook has nothing for them, or refuses a stranger). */
export async function padFees(hit: VenueHit, creator: Address): Promise<PadFeeView> {
  const c = publicClient()
  if (hit.pad === "boxa") {
    const claimableWei = await c.readContract({ address: hit.key.hooks, abi: BOXA_HOOK_ABI, functionName: "claimable", args: [hit.key.currency1, creator] }).catch(() => 0n)
    return { pad: "boxa", payer: hit.key.hooks, claimableWei }
  }
  const claimableWei = await c.simulateContract({ address: MONTRA.hook, abi: MONTRA_HOOK_FEES_ABI, functionName: "claim", args: [hit.poolId, creator], account: creator }).then((r) => r.result).catch(() => 0n)
  return { pad: "montra", payer: MONTRA.hook, claimableWei }
}

/** The unsigned claim calldata: BOXA claim(token, to) on the pool's hook; Montra claim(poolId, to) on its hook (from the creator). */
export function padClaimCalldata(hit: VenueHit, to: Address): Hex {
  if (hit.pad === "boxa") return encodeFunctionData({ abi: BOXA_HOOK_ABI, functionName: "claim", args: [hit.key.currency1, to] })
  return encodeFunctionData({ abi: MONTRA_HOOK_FEES_ABI, functionName: "claim", args: [hit.poolId, to] })
}
