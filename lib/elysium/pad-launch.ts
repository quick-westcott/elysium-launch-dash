/**
 * Launching on Montra and BOXA. Each call was decoded from a real launch sent by the pad's own UI (the launcher's
 * research/pad-launch-decode.mjs, 2026-11-05) and re-encoded byte for byte; the parameter choices were accepted by
 * eth_call simulations from a funded address. Every launch is simulated again right before signing, which is also
 * where the coin's address comes from: both pads return it, and both create it by CREATE2 with the salt baked into
 * the calldata, so the simulated address is the real one as long as this exact calldata is signed.
 *
 *  - MONTRA  factory 0x38D3…cD15, selector 0x579ba2d5 (name unpublished; the tuple layout is exact), value = the dev
 *    buy in native HYPE. THE TWO URI SLOTS, THE RIGHT WAY ROUND: the tuple's third string is the TOKEN URI (the
 *    pinned metadata JSON) and the first string inside `meta` is the IMAGE. Montra's indexer reads the third string
 *    as the token URI, so a launch with them swapped shows no art and no description (that was our 11/5 bug, fixed
 *    here). Four trailing numbers every launch sends as 0 (the fee / anti-snipe config is the hook's default). Their
 *    UI appends a 24-byte ERC-8021 attribution tag; the factory accepts the call with or without it — kept.
 *  - BOXA    launcher.launch(params) payable, value = quoteIn (the dev buy), a CHECKED call: expectedExtraCutBps must
 *    equal hook.extraCutBps() (read live) and expectedStartTick the launcher's opening tick (166200; any other
 *    reverts 0x4ec0a691). creatorBps 10000 to us; an EXTRA fee in pips (1e-6) on top of the hook's own cut, 0 % is
 *    what its UI sends, 2 % accepted, 10 % refused. Returns (token, poolId). Metadata is an inline JSON string.
 *
 *  Receipt: the Initialize log on the main PoolManager (the coin is currency1; native HYPE is currency0) and the
 *  coin's Transfers to the dev summed as the dev bag. Both pads mint the dev bag to the launching WALLET (not a desk);
 *  the launch executor moves it into the dev's desk right after, so the exit is one approval-free call.
 */
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseEther, type Address, type Hex } from "viem"
import { ADDR, publicClient } from "./chain"
import { randomSalt } from "./ascend"
import { BOXA, BOXA_HOOK_ABI, MONTRA, type ElysiumPad } from "./pads"

const ZERO: Address = "0x0000000000000000000000000000000000000000"
const V4_INITIALIZE_TOPIC: Hex = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"
const ERC20_TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

export type PadLinks = { website?: string; twitter?: string; telegram?: string; discord?: string }
export type PadLaunchInput = { name: string; symbol: string; description: string; imageUri: string; devBuyWei: bigint } & PadLinks

/** ipfs://cid → an ipfs.io gateway link (BOXA's inline metadata wants an https image). */
const httpImage = (uri: string): string => (uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}` : uri)

/*//////////////////////////////////////////////////////////////////////
                               MONTRA
//////////////////////////////////////////////////////////////////////*/

export const MONTRA_LAUNCH_SELECTOR: Hex = "0x579ba2d5"
/** The tag Montra's UI appends after the ABI data ("montra" + 18 bytes, an ERC-8021 attribution); accepted with or without it. */
export const MONTRA_LAUNCH_SUFFIX: Hex = "0x6d6f6e747261060080218021802180218021802180218021"
/** 1.9M: 1.4M reverted on every Montra launch whose description ran past about 480 chars (measured 11/8: 1.49M at the
 *  600-char cap trending.ts copies, 1.04M with no description), because the image and token URI are written to storage
 *  in the launch. Worst case measured 1.514M. BOXA already used 1.9M for the same reason. */
export const MONTRA_LAUNCH_GAS = 1_900_000n

type MontraLaunchParams = {
  name: string; symbol: string; tokenUri: string
  meta: { image: string; description: string; links: { website: string; twitter: string; telegram: string; discord: string; other: string } }
  quote: Address; supply: bigint; salt: Hex; s1: string; s2: string
  devBuy: bigint; minOut: bigint; a: bigint; b: bigint; c: bigint; d: bigint
}
const MONTRA_TUPLE = [{ type: "tuple", components: [
  { type: "string", name: "name" }, { type: "string", name: "symbol" }, { type: "string", name: "tokenUri" },
  { type: "tuple", name: "meta", components: [
    { type: "string", name: "image" }, { type: "string", name: "description" },
    { type: "tuple", name: "links", components: [{ type: "string", name: "website" }, { type: "string", name: "twitter" }, { type: "string", name: "telegram" }, { type: "string", name: "discord" }, { type: "string", name: "other" }] },
  ] },
  { type: "address", name: "quote" }, { type: "uint256", name: "supply" }, { type: "bytes32", name: "salt" }, { type: "string", name: "s1" }, { type: "string", name: "s2" },
  { type: "uint256", name: "devBuy" }, { type: "uint256", name: "minOut" }, { type: "uint256", name: "a" }, { type: "uint256", name: "b" }, { type: "uint256", name: "c" }, { type: "uint256", name: "d" },
] }] as const

/** The token-URI document the way Montra's own UI pins it: name, symbol, description, the image, only the links that
 *  are set, and the launch_provider / chain attributes its indexer tags coins with. `seal` (when the launch's wallets
 *  were resolved) rides the JSON under `signature`, so the coin carries its own recovery record on IPFS
 *  (lib/wallet-recovery.ts) exactly like an Ascend launch. */
export function montraMetadataJson(f: Omit<PadLaunchInput, "devBuyWei">, seal?: string): Record<string, unknown> {
  return {
    name: f.name, symbol: f.symbol, description: f.description, image: f.imageUri,
    ...(f.website ? { website: f.website } : {}), ...(f.twitter ? { twitter: f.twitter } : {}),
    ...(f.telegram ? { telegram: f.telegram } : {}), ...(f.discord ? { discord: f.discord } : {}),
    ...(seal ? { signature: seal } : {}),
    attributes: [{ trait_type: "launch_provider", value: "montra" }, { trait_type: "chain", value: "elysium" }],
  }
}

/** The Montra launch call: the pinned JSON in the token-URI slot, the image inside `meta`, the dev buy as value. */
export function buildMontraLaunch(f: PadLaunchInput & { tokenUri: string }): { to: Address; data: Hex; value: bigint; gas: bigint } {
  const p: MontraLaunchParams = {
    name: f.name, symbol: f.symbol, tokenUri: f.tokenUri,
    meta: { image: f.imageUri, description: f.description, links: { website: f.website ?? "", twitter: f.twitter ?? "", telegram: f.telegram ?? "", discord: f.discord ?? "", other: "" } },
    quote: ZERO, supply: parseEther("1000000000"), salt: randomSalt(), s1: "", s2: "",
    // the pool is born in this transaction; nothing trades ahead of the dev buy inside it
    devBuy: f.devBuyWei, minOut: 0n, a: 0n, b: 0n, c: 0n, d: 0n,
  }
  const body = encodeAbiParameters(MONTRA_TUPLE, [p])
  const data = `${MONTRA_LAUNCH_SELECTOR}${body.slice(2)}${MONTRA_LAUNCH_SUFFIX.slice(2)}` as Hex
  return { to: MONTRA.factory, data, value: f.devBuyWei, gas: MONTRA_LAUNCH_GAS }
}

/*//////////////////////////////////////////////////////////////////////
                                BOXA
//////////////////////////////////////////////////////////////////////*/

export const BOXA_ABI = parseAbi([
  "function launch((string name,string symbol,bytes32 salt,address quote,uint16 creatorBps,uint16 buybackBps,uint16 holdersBps,uint24 buyExtraPips,uint24 sellExtraPips,uint16 expectedExtraCutBps,int24 expectedStartTick,uint256 quoteIn,uint256 minTokensOut,uint256 deadline,string metadata) params) payable returns (address token, bytes32 poolId)",
])
/** The opening tick BOXA's UI sends (WOOF, $1: 166200); the launcher refuses any other. */
export const BOXA_START_TICK = 166_200
export const BOXA_LAUNCH_GAS = 1_900_000n
/** BOXA's extra fee presets, in bps on top of the hook's own cut (0 is what its UI sends; 5 % is the most accepted). */
export const BOXA_FEE_PRESETS = [0, 100, 200, 300, 500] as const

/** The BOXA launch call: reads the hook's extraCutBps (the checked value) and prices the extra fee from `feeBps` (0–500).
 *  `seal` rides the inline metadata JSON under `signature` when the launch's wallets were resolved. */
export async function buildBoxaLaunch(f: PadLaunchInput & { feeBps: number }, seal?: string): Promise<{ to: Address; data: Hex; value: bigint; gas: bigint }> {
  if (f.feeBps < 0 || f.feeBps > 500) throw new Error("BOXA extra fee must be between 0 % and 5 %")
  const extraCutBps = await publicClient().readContract({ address: BOXA.hook, abi: BOXA_HOOK_ABI, functionName: "extraCutBps" })
  const params = {
    name: f.name, symbol: f.symbol, salt: randomSalt(), quote: ZERO, creatorBps: 10_000, buybackBps: 0, holdersBps: 0,
    buyExtraPips: f.feeBps * 100, sellExtraPips: f.feeBps * 100, expectedExtraCutBps: Number(extraCutBps), expectedStartTick: BOXA_START_TICK,
    quoteIn: f.devBuyWei, minTokensOut: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    metadata: JSON.stringify({ image: httpImage(f.imageUri), description: f.description, ...(f.website ? { website: f.website } : {}), ...(f.twitter ? { twitter: f.twitter } : {}), ...(f.telegram ? { telegram: f.telegram } : {}), ...(seal ? { signature: seal } : {}) }),
  }
  return { to: BOXA.launcher, data: encodeFunctionData({ abi: BOXA_ABI, functionName: "launch", args: [params] }), value: f.devBuyWei, gas: BOXA_LAUNCH_GAS }
}

/*//////////////////////////////////////////////////////////////////////
                         PREDICTION + RECEIPTS
//////////////////////////////////////////////////////////////////////*/

/** The coin a pad launch returns: the first word of its return data (Montra returns the token; BOXA (token, poolId)). */
export function launchPredictedToken(returnData: Hex | undefined): Address | null {
  if (!returnData || returnData.length < 66) return null
  const a = `0x${returnData.slice(26, 66)}` as Address
  return a === ZERO ? null : a
}

export type PadLaunchReceipt = { token: Address; poolId: Hex; devTokens: bigint }

/** The coin and its pool off a launch receipt (the Initialize log on the main PoolManager), and the dev bag (the coin's Transfers to `recipient`). */
export function decodePadLaunchReceipt(logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[], recipient: Address): PadLaunchReceipt | null {
  const pm = ADDR.poolManager.toLowerCase()
  const init = logs.find((l) => l.address.toLowerCase() === pm && l.topics[0] === V4_INITIALIZE_TOPIC && l.topics.length >= 4)
  if (!init) return null
  const c0 = `0x${init.topics[2].slice(26)}` as Address
  const c1 = `0x${init.topics[3].slice(26)}` as Address
  const token = c0 === ZERO ? c1 : c0
  const to = recipient.toLowerCase()
  let devTokens = 0n
  for (const l of logs) {
    if (l.address.toLowerCase() !== token.toLowerCase() || l.topics[0] !== ERC20_TRANSFER_TOPIC || l.topics.length < 3) continue
    if (`0x${l.topics[2].slice(26)}`.toLowerCase() !== to) continue
    if (l.data && l.data !== "0x") devTokens += BigInt(l.data)
  }
  return { token, poolId: init.topics[1], devTokens }
}

export const padName = (pad: ElysiumPad) => (pad === "montra" ? "Montra" : "BOXA")
