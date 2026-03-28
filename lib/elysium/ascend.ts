/**
 * Launching on Ascend (app.ascendlaunch.xyz) and reading what it leaves behind. Decoded from real launches
 * (WOK 11/5, selector 0x01c2cec9) and reproduced by the launcher this app is cut from.
 *
 *   EscrowFactory.launchChecked(p, r, ruleSet, startTick)
 *     p = { name, symbol, quote: WHYPE, devBuyQuote, minDevOut: 0, salt, creator: 0 (= sender), fee, builderFee: 0 }
 *     r = { recipient: dev wallet, dev: the DESK when the wallet has one (the bag lands there, so the exit needs no
 *           approvals), builder: 0, cto: true }
 *   The dev buy is `devBuyQuote` of WHYPE pulled by approval in the same transaction: wrap + approve go first. The
 *   opening tick is -168600 for a WHYPE pair (the other sign when the coin sorts above WHYPE); the simulation picks.
 *   Appended to the calldata: abi.encode(bytes32 "ascend.metadata.v1", string ipfs://…) — the suffix Ascend's own
 *   UI used; their indexer only shows art pinned through their Turnstile-gated API, so this is best effort.
 *   Receipt: Launched(poolId, coin) on the Launchpad hook, EscrowLaunched(poolId, escrow, recipient) on the factory.
 *
 *   Fees: every trade pays the pool's fee (1–10 %, fixed at launch) in WHYPE into the CreatorEscrow. At 1 % the
 *   creator's cut is held until graduation ($40k mcap for an hour inside 14 days, else forfeited); above 1 % the
 *   excess is the creator's and claimable as it accrues. escrow.claim(account) takes it.
 */
import { concatHex, encodeAbiParameters, encodeFunctionData, parseAbi, stringToHex, type Address, type Hex } from "viem"
import { ADDR, publicClient } from "./chain"
import { ascendKey, ERC20_ABI, poolExists, poolIdOf } from "./v4"

export const FACTORY_ABI = parseAbi([
  "function launchChecked((string name,string symbol,address quote,uint256 devBuyQuote,uint256 minDevOut,bytes32 salt,address creator,uint24 fee,uint24 builderFee) p, (address recipient,address dev,address builder,bool cto) r, address ruleSet, int24 startTick) returns (address token, bytes32 poolId, address escrow)",
  "function ruleSet() view returns (address)",
  "function escrowOf(bytes32 poolId) view returns (address)",
])
export const LAUNCHPAD_ABI = parseAbi([
  "function paused() view returns (bool)",
  "function collectedFees(bytes32 poolId) view returns (uint256)",
  "function currentFee(bytes32 poolId) view returns (uint24)",
])
export const ESCROW_ABI = parseAbi([
  "function claimable(address account) view returns (uint256 amount)",
  "function claim(address account) returns (uint256)",
  "function recipient() view returns (address)",
  "function held() view returns (uint256)",
  "function deadline() view returns (uint40)",
])
export const WETH9_ABI = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
])

export const START_TICK_WHYPE = -168_600
export const FEE_PRESETS = [10_000, 20_000, 30_000, 50_000, 100_000] as const
export const LAUNCH_GAS = 6_500_000n
export const LAUNCHED_TOPIC: Hex = "0x242096c9c73ff8e4f2521256ab8f117830e049ebbd04b1a8bff1cf6d1fb51ac3"
export const ESCROW_LAUNCHED_TOPIC: Hex = "0x9f8b158a1c64e52870ee742661e36bb7f7c52b0cd660727a80af56907dab15ff"
const ZERO: Address = "0x0000000000000000000000000000000000000000"
const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const METADATA_TAG: Hex = stringToHex("ascend.metadata.v1", { size: 32 })

export type LaunchParams = { name: string; symbol: string; devBuyWei: bigint; feePpm: number; salt?: Hex; devReceiver?: Address; metadataUri?: string | null; cto?: boolean }

export function randomSalt(): Hex {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`
}

export function launchArgs(sender: Address, p: LaunchParams, ruleSet: Address, startTick: number) {
  return [
    { name: p.name, symbol: p.symbol, quote: ADDR.whype, devBuyQuote: p.devBuyWei, minDevOut: 0n, salt: p.salt ?? randomSalt(), creator: ZERO, fee: p.feePpm, builderFee: 0 },
    { recipient: sender, dev: p.devReceiver ?? sender, builder: ZERO, cto: p.cto ?? true },
    ruleSet, startTick,
  ] as const
}

export function launchCalldata(sender: Address, p: LaunchParams, ruleSet: Address, startTick: number): Hex {
  const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "launchChecked", args: launchArgs(sender, p, ruleSet, startTick) })
  if (!p.metadataUri) return data
  // a base32 CIDv1 is 59 chars; the ablation suffix costs another 96, so 160 keeps every real URI inside the limit
  if (!/^ipfs:\/\/[A-Za-z0-9]{46,}$/.test(p.metadataUri) || p.metadataUri.length > 160) throw new Error("Launch metadata must be an ipfs:// CID")
  return concatHex([data, encodeAbiParameters([{ type: "bytes32" }, { type: "string" }], [METADATA_TAG, p.metadataUri])])
}

/**
 * Which opening tick the factory accepts for this coin, by simulation from the sender (the WHYPE allowance must be in
 * place first, so run it after the approve lands, or with devBuyWei 0 to check the terms alone). Throws with the
 * factory's reason when neither sign is accepted.
 */
export async function pickStartTick(sender: Address, p: LaunchParams): Promise<{ ruleSet: Address; startTick: number }> {
  const c = publicClient()
  const [paused, ruleSet] = await Promise.all([
    c.readContract({ address: ADDR.launchpad, abi: LAUNCHPAD_ABI, functionName: "paused" }),
    c.readContract({ address: ADDR.escrowFactory, abi: FACTORY_ABI, functionName: "ruleSet" }),
  ])
  if (paused) throw new Error("Ascend has paused launches. Nothing was sent.")
  let last = ""
  for (const tick of [START_TICK_WHYPE, -START_TICK_WHYPE]) {
    try {
      await c.simulateContract({ address: ADDR.escrowFactory, abi: FACTORY_ABI, functionName: "launchChecked", args: launchArgs(sender, { ...p, salt: p.salt ?? randomSalt() }, ruleSet, tick), account: sender })
      return { ruleSet, startTick: tick }
    } catch (e) {
      last = (e as { shortMessage?: string })?.shortMessage ?? (e as Error).message
    }
  }
  throw new Error(`Ascend refused the launch in simulation: ${last.slice(0, 200)}. Nothing was sent.`)
}

export type LaunchReceipt = { token: Address; poolId: Hex; escrow: Address | null; devTokens: bigint }

/** The coin, its pool and escrow off a launch receipt, and the dev fill (the coin's Transfer to `devReceiver`). */
export function decodeLaunchReceipt(logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[], devReceiver: Address): LaunchReceipt | null {
  let token: Address | null = null, poolId: Hex | null = null, escrow: Address | null = null
  const addr = (t: Hex): Address => `0x${t.slice(26)}` as Address
  for (const l of logs) {
    if (l.address.toLowerCase() === ADDR.launchpad.toLowerCase() && l.topics[0] === LAUNCHED_TOPIC && l.topics.length >= 3) { poolId = l.topics[1]; token = addr(l.topics[2]) }
    if (l.address.toLowerCase() === ADDR.escrowFactory.toLowerCase() && l.topics[0] === ESCROW_LAUNCHED_TOPIC && l.topics.length >= 3) escrow = addr(l.topics[2])
  }
  if (!token || !poolId) return null
  const to = `0x${devReceiver.slice(2).toLowerCase().padStart(64, "0")}`
  let devTokens = 0n
  for (const l of logs) if (l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics[2]?.toLowerCase() === to) devTokens += BigInt(l.data)
  return { token, poolId, escrow, devTokens }
}

/** Name, symbol, supply and whether an Ascend WHYPE pool exists for a coin. */
export async function tokenInfo(token: Address): Promise<{ name: string; symbol: string; totalSupply: bigint; poolId: Hex; hasPool: boolean }> {
  const c = publicClient()
  const { key } = ascendKey(token)
  const poolId = poolIdOf(key)
  const [name, symbol, totalSupply, hasPool] = await Promise.all([
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "name" }).catch(() => "?"),
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "totalSupply" }).catch(() => 0n),
    poolExists(poolId).catch(() => false),
  ])
  return { name, symbol, totalSupply, poolId, hasPool }
}

export type FeeView = { escrow: Address; recipient: Address; claimableWei: bigint; heldWei: bigint; deadline: number; collectedWei: bigint; feePpm: number }

/** The creator escrow of a coin and what it holds for `creator`. */
export async function feeView(token: Address, creator: Address): Promise<FeeView> {
  const c = publicClient()
  const poolId = poolIdOf(ascendKey(token).key)
  const escrow = await c.readContract({ address: ADDR.escrowFactory, abi: FACTORY_ABI, functionName: "escrowOf", args: [poolId] })
  if (!escrow || escrow === ZERO) throw new Error("Ascend has no creator escrow for this coin (not an Ascend launch, or launched through its V5 seat path)")
  const [recipient, claimableWei, heldWei, deadline, collectedWei, feePpm] = await Promise.all([
    c.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "recipient" }),
    c.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "claimable", args: [creator] }),
    c.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "held" }),
    c.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "deadline" }),
    c.readContract({ address: ADDR.launchpad, abi: LAUNCHPAD_ABI, functionName: "collectedFees", args: [poolId] }).catch(() => 0n),
    c.readContract({ address: ADDR.launchpad, abi: LAUNCHPAD_ABI, functionName: "currentFee", args: [poolId] }).catch(() => 0),
  ])
  return { escrow, recipient, claimableWei, heldWei, deadline: Number(deadline), collectedWei, feePpm: Number(feePpm) }
}

export const claimCalldata = (account: Address): Hex => encodeFunctionData({ abi: ESCROW_ABI, functionName: "claim", args: [account] })
export const wrapCalldata = (): Hex => encodeFunctionData({ abi: WETH9_ABI, functionName: "deposit" })
export const approveWhypeCalldata = (wei: bigint): Hex => encodeFunctionData({ abi: WETH9_ABI, functionName: "approve", args: [ADDR.escrowFactory, wei] })
export const unwrapCalldata = (wei: bigint): Hex => encodeFunctionData({ abi: WETH9_ABI, functionName: "withdraw", args: [wei] })
