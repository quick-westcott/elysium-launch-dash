/**
 * Uniswap V4 on Elysium: pool keys, quotes, and the UniversalRouter calldata for a wallet that buys with native
 * HYPE and sells back to native HYPE on a pool quoted in WHYPE. Reproduced command for command from Ascend's own UI
 * (the e/acc buy 0x4acb…43fe, 11/5): Elysium's router is the newer periphery build whose ExactInputSingleParams
 * carries `maxHopSlippage` before hookData, so it is always encoded (as 0).
 *
 *   buy:   WRAP_ETH(router, amountIn) · V4_SWAP[ SWAP_EXACT_IN_SINGLE, SETTLE(WHYPE, open, payerIsUser=false),
 *          TAKE(token, msg.sender, open) ] · UNWRAP_WETH(msg.sender, 0) · SWEEP(native, msg.sender, 0)   value = amountIn
 *   sell:  V4_SWAP[ SWAP_EXACT_IN_SINGLE, SETTLE_ALL(token, amountIn), TAKE(WHYPE, router, open) ] · UNWRAP_WETH(msg.sender, minOut)
 *          (the token is pulled through Permit2: token → Permit2 approve, then Permit2.approve(token, router))
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from "viem"
import { ADDR, publicClient } from "./chain"

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export type Call = { to: Address; data: Hex; value: bigint }

const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
] as const

export function poolIdOf(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ))
}

/** Ascend pools: sorted currencies, the dynamic-fee flag, spacing 200, the Launchpad hook. */
export const ASCEND_POOL_FEE = 0x800000
export const ASCEND_TICK_SPACING = 200
export function ascendKey(token: Address, quote: Address = ADDR.whype): { key: PoolKey; tokenIsCurrency0: boolean } {
  const tokenIsCurrency0 = BigInt(token) < BigInt(quote)
  return {
    key: { currency0: tokenIsCurrency0 ? token : quote, currency1: tokenIsCurrency0 ? quote : token, fee: ASCEND_POOL_FEE, tickSpacing: ASCEND_TICK_SPACING, hooks: ADDR.launchpad },
    tokenIsCurrency0,
  }
}

const STATE_VIEW_ABI = [{
  type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }],
  outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }, { name: "protocolFee", type: "uint24" }, { name: "lpFee", type: "uint24" }],
}] as const

/** True when the PoolManager has this pool (StateView answers zeros for one never initialized). */
export async function poolExists(poolId: Hex): Promise<boolean> {
  const [sqrtPriceX96] = await publicClient().readContract({ address: ADDR.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] })
  return sqrtPriceX96 > 0n
}

// ── calldata ──────────────────────────────────────────────────────────────────

function encodeExactInSingle(p: { key: PoolKey; zeroForOne: boolean; amountIn: bigint; amountOutMinimum: bigint }): Hex {
  return encodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS },
      { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" },
      { name: "maxHopSlippage", type: "uint256" }, { name: "hookData", type: "bytes" },
    ] }],
    [{ poolKey: p.key, zeroForOne: p.zeroForOne, amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum, maxHopSlippage: 0n, hookData: "0x" }],
  )
}

const CMD_V4_SWAP = 0x10, CMD_WRAP_ETH = 0x0b, CMD_UNWRAP_WETH = 0x0c, CMD_SWEEP = 0x04
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f } as const
const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002"
const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001"
const NATIVE: Address = "0x0000000000000000000000000000000000000000"
const EXECUTE_ABI = [{ type: "function", name: "execute", stateMutability: "payable", inputs: [{ name: "commands", type: "bytes" }, { name: "inputs", type: "bytes[]" }, { name: "deadline", type: "uint256" }], outputs: [] }] as const
const bytesOf = (...b: number[]): Hex => `0x${b.map((x) => x.toString(16).padStart(2, "0")).join("")}`
const deadlineIn = (seconds: number) => BigInt(Math.floor(Date.now() / 1000) + seconds)

/** HYPE → token. `value = amountIn`. */
export function buyCall(token: Address, amountIn: bigint, minOut: bigint): Call {
  const { key, tokenIsCurrency0 } = ascendKey(token)
  const quoteIs0 = !tokenIsCurrency0
  const swap = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [
    bytesOf(ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE, ACT.TAKE),
    [
      encodeExactInSingle({ key, zeroForOne: quoteIs0, amountIn, amountOutMinimum: minOut }),
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [ADDR.whype, 0n, false]),
      encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [token, MSG_SENDER, 0n]),
    ],
  ])
  const wrap = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ADDRESS_THIS, amountIn])
  const unwrap = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [MSG_SENDER, 0n])
  const sweep = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [NATIVE, MSG_SENDER, 0n])
  return { to: ADDR.universalRouter, data: encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [bytesOf(CMD_WRAP_ETH, CMD_V4_SWAP, CMD_UNWRAP_WETH, CMD_SWEEP), [wrap, swap, unwrap, sweep], deadlineIn(600)] }), value: amountIn }
}

/** token → HYPE (unwrapped to the seller). Needs the two Permit2 allowances. */
export function sellCall(token: Address, amountIn: bigint, minOut: bigint): Call {
  const { key, tokenIsCurrency0 } = ascendKey(token)
  const swap = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [
    bytesOf(ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE),
    [
      encodeExactInSingle({ key, zeroForOne: tokenIsCurrency0, amountIn, amountOutMinimum: minOut }),
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, amountIn]),
      encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [ADDR.whype, ADDRESS_THIS, 0n]),
    ],
  ])
  const unwrap = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [MSG_SENDER, minOut])
  return { to: ADDR.universalRouter, data: encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [bytesOf(CMD_V4_SWAP, CMD_UNWRAP_WETH), [swap, unwrap], deadlineIn(600)] }), value: 0n }
}

/**
 * Any exact-in single-pool swap through the UniversalRouter on a NATIVE-HYPE pool (currency0 = address 0): one V4_SWAP
 * of SWAP_EXACT_IN_SINGLE · SETTLE_ALL(currencyIn, amountIn) · TAKE_ALL(currencyOut, minOut). Value goes only when the
 * input is native. This is what the pads (Montra, BOXA) trade through — no wrap/unwrap, unlike Ascend's WHYPE pools.
 * An ERC-20 input (a sell) settles through Permit2, so the seller needs `sellApprovals` first.
 */
export function v4ExactInCall(key: PoolKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint): Call {
  const [currencyIn, currencyOut] = zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0]
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [
    bytesOf(ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL),
    [
      encodeExactInSingle({ key, zeroForOne, amountIn, amountOutMinimum: minOut }),
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyIn, amountIn]),
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyOut, minOut]),
    ],
  ])
  return { to: ADDR.universalRouter, data: encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [bytesOf(CMD_V4_SWAP), [input], deadlineIn(600)] }), value: currencyIn === NATIVE ? amountIn : 0n }
}

// ── quotes ────────────────────────────────────────────────────────────────────

const V4_QUOTER_ABI = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS }, { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" },
  ] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}] as const

/** Exact-in quote on any pool key; null when the quoter reverts (no pool, hook refused), throws when it could not be asked. */
export async function quoteKey(key: PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint | null> {
  try {
    const { result } = await publicClient().simulateContract({ address: ADDR.quoter, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }] })
    return result[0] > 0n ? result[0] : null
  } catch (e) {
    const text = `${(e as { shortMessage?: string })?.shortMessage ?? ""} ${(e as Error)?.message ?? ""}`
    if (/revert/i.test(text)) return null
    throw e
  }
}

/** Exact-in quote for an Ascend coin (vs WHYPE); null when the quoter reverts (no pool, hook refused). */
export async function quote(token: Address, action: "buy" | "sell", amountIn: bigint): Promise<bigint | null> {
  const { key, tokenIsCurrency0 } = ascendKey(token)
  return quoteKey(key, action === "buy" ? !tokenIsCurrency0 : tokenIsCurrency0, amountIn)
}

// ── Permit2 ───────────────────────────────────────────────────────────────────

export const PERMIT2_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "spender", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }], outputs: [] },
] as const
export const PERMIT2_MAX_AMOUNT = (1n << 160n) - 1n
export const PERMIT2_MAX_EXPIRATION = 2 ** 48 - 1
export const ERC20_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const
const MAX = (1n << 256n) - 1n

/** The approvals a wallet still needs before the router can pull `token` for a sell: 0, 1 or 2 transactions. */
export async function sellApprovals(owner: Address, token: Address): Promise<Call[]> {
  const c = publicClient()
  const [erc20, [amount, expiration]] = await Promise.all([
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, ADDR.permit2] }),
    c.readContract({ address: ADDR.permit2, abi: PERMIT2_ABI, functionName: "allowance", args: [owner, token, ADDR.universalRouter] }),
  ])
  const out: Call[] = []
  if (erc20 < MAX / 2n) out.push({ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [ADDR.permit2, MAX] }), value: 0n })
  if (amount < PERMIT2_MAX_AMOUNT / 2n || expiration <= Math.floor(Date.now() / 1000) + 7 * 86_400) {
    out.push({ to: ADDR.permit2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: "approve", args: [token, ADDR.universalRouter, PERMIT2_MAX_AMOUNT, PERMIT2_MAX_EXPIRATION] }), value: 0n })
  }
  return out
}

export const BUY_GAS = 700_000n
export const SELL_GAS = 700_000n
export const APPROVE_GAS = 120_000n
