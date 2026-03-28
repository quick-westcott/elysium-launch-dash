/**
 * The tape of one coin: every Swap on its Ascend pool, read off the PoolManager's logs. There is no push feed on the
 * relays, so a follower polls every 600 ms (a 160 ms chain: about four blocks of lag). The sender of each swap is the
 * transaction's `from`, read once per hash.
 */
import { type Address, type Hex } from "viem"
import { ADDR, publicClient } from "./chain"
import { resolveVenue } from "./pads"

export const SWAP_TOPIC: Hex = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
const LAUNCHED_TOPIC: Hex = "0x242096c9c73ff8e4f2521256ab8f117830e049ebbd04b1a8bff1cf6d1fb51ac3"
const INITIALIZE_TOPIC: Hex = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"

export type Swap = { hash: string; block: number; logIndex: number; type: "buy" | "sell"; hype: number; tokens: number; trader: string; timestamp: number }

type RawLog = { address: Address; topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex; logIndex: Hex }
const hex = (n: bigint | "latest") => (n === "latest" ? "latest" : `0x${n.toString(16)}`)
/**
 * eth_getLogs with the topics exactly as given. viem's getLogs builds its filter from `event`/`args` and silently drops
 * a raw `topics` key, which turned this into "every Swap on the PoolManager"; the raw request keeps the filter.
 */
async function rawLogs(address: Address, fromBlock: bigint, toBlock: bigint | "latest", topics: (Hex | null)[]): Promise<RawLog[]> {
  const r = await publicClient().request({ method: "eth_getLogs", params: [{ address, fromBlock: hex(fromBlock), toBlock: hex(toBlock), topics }] } as never)
  return (r as RawLog[]) ?? []
}

const fromCache = new Map<string, string>()
async function senderOf(hash: Hex): Promise<string> {
  const hit = fromCache.get(hash)
  if (hit) return hit
  const tx = await publicClient().getTransaction({ hash })
  fromCache.set(hash, tx.from)
  if (fromCache.size > 2000) fromCache.delete(fromCache.keys().next().value!)
  return tx.from
}

const tsCache = new Map<number, number>()
async function timestampOf(block: number): Promise<number> {
  const hit = tsCache.get(block)
  if (hit) return hit
  const b = await publicClient().getBlock({ blockNumber: BigInt(block) })
  const ts = Number(b.timestamp) * 1000
  tsCache.set(block, ts)
  if (tsCache.size > 2000) tsCache.delete(tsCache.keys().next().value!)
  return ts
}

/** The swaps of `token`'s pool (Ascend, Montra or BOXA — all on the main PoolManager) in [fromBlock, toBlock], oldest first. */
export async function swapsOf(token: Address, fromBlock: bigint, toBlock: bigint | "latest" = "latest"): Promise<Swap[]> {
  const hit = await resolveVenue(token)
  if (!hit) return []
  const { poolId, tokenIsCurrency0 } = hit
  const logs = await rawLogs(hit.poolManager, fromBlock, toBlock, [SWAP_TOPIC, poolId])
  const out: Swap[] = []
  for (const l of logs) {
    if (l.topics[1]?.toLowerCase() !== poolId.toLowerCase()) continue // belt and braces for a relay that drops the filter
    const d = l.data.slice(2)
    const a0 = BigInt.asIntN(128, BigInt(`0x${d.slice(0, 64)}`)), a1 = BigInt.asIntN(128, BigInt(`0x${d.slice(64, 128)}`))
    const tokenDelta = tokenIsCurrency0 ? a0 : a1, hypeDelta = tokenIsCurrency0 ? a1 : a0
    const buy = tokenDelta > 0n
    const [trader, timestamp] = await Promise.all([senderOf(l.transactionHash), timestampOf(Number(l.blockNumber))])
    out.push({ hash: l.transactionHash, block: Number(l.blockNumber), logIndex: Number(l.logIndex), type: buy ? "buy" : "sell", hype: Number(buy ? -hypeDelta : hypeDelta) / 1e18, tokens: Number(buy ? tokenDelta : -tokenDelta) / 1e18, trader, timestamp })
  }
  return out
}

/**
 * The pool's launch block, searched back in 10k-block windows (the relays' getLogs cap): Ascend's Launched log that
 * named this coin, or — for a pad coin — the PoolManager's Initialize log of its pool.
 */
export async function launchBlockOf(token: Address, maxBack = 300_000): Promise<bigint | null> {
  const c = publicClient()
  const head = await c.getBlockNumber()
  const hit = await resolveVenue(token)
  const address = hit && hit.venue !== "ascend" ? hit.poolManager : ADDR.launchpad
  const topics: (Hex | null)[] = hit && hit.venue !== "ascend" ? [INITIALIZE_TOPIC, hit.poolId] : [LAUNCHED_TOPIC, null, `0x${token.slice(2).toLowerCase().padStart(64, "0")}` as Hex]
  for (let to = head; to > head - BigInt(maxBack) && to > 0n; to -= 10_000n) {
    const from = to - 9_999n > 0n ? to - 9_999n : 0n
    const logs = await rawLogs(address, from, to, topics)
    if (logs.length) return BigInt(logs[0].blockNumber)
  }
  return null
}
