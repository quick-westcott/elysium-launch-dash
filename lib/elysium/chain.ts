/**
 * Elysium (Kinetiq's Hyperliquid L2, Arbitrum Orbit, chain 99901, HYPE as the native coin) as this app sees it:
 * the chain, the relays, the contracts and one public client. Server-side only (node fetch, no window).
 *
 * RELAYS. There is no official public RPC before the public launch; the community relays all front the one
 * sequencer. Measured 11/5: Agoradex ~200 ms, Volta ~250 ms, Kleos ~500 ms, BOXA ~250 ms but refuses web origins and
 * holds sends in its own queue, ElysPump 2–5 s with drops. Reads run over the fast three; every signed transaction
 * goes to ALL send relays at once (fanout-send.ts) and the first acceptance wins. ELYSIUM_RPC_URLS (comma list)
 * overrides the defaults; the official Conduit endpoint goes first the day it opens.
 *
 * CONTRACTS are Ascend's published mainnet set (from block 422319), cross-checked against live launches and trades.
 */
import { createPublicClient, defineChain, fallback, http, type Address, type Hex, type PublicClient } from "viem"
import { fanoutSendRaw } from "./fanout-send"
import { appState } from "../state"

export const ELYSIUM_CHAIN_ID = 99901

export type SimCall = { from: Address; to: Address; data: Hex; value: bigint }
export type SimStep = { ok: boolean; gasUsed: bigint | null; error: string | null }
/**
 * eth_simulateV1: the calls run one after another on top of the latest block, each seeing the state the previous
 * ones left (so a wrap → approve → create sequence dry-runs as a whole). Tried over the read relays in order; a relay
 * without the method (-32601) is skipped; null when none has it. `validation: false` keeps nonces and balances out of
 * the way except where a call itself needs value.
 */
export async function simulateSequence(calls: SimCall[]): Promise<SimStep[] | null> {
  const r = await simulateRaw(calls, false)
  if (!r) return null
  // the whole simulation was refused (e.g. the sender cannot cover a value): report it on the first call
  if ("refused" in r) return calls.map((_, i) => ({ ok: false, gasUsed: null, error: i === 0 ? r.refused : "not reached" }))
  return r.calls.map((c) => ({ ok: c.status === "0x1", gasUsed: c.gasUsed ? BigInt(c.gasUsed) : null, error: c.status === "0x1" ? null : (c.error?.message ?? "reverted").slice(0, 200) }))
}

type RawSimCall = { status: string; gasUsed?: string; returnData?: string; error?: { message?: string }; logs?: Array<{ address: string; topics: string[]; data: string }> }
/** One eth_simulateV1 over the read relays that have it; `refused` when the whole simulation was turned down, null when no relay has the method. */
async function simulateRaw(calls: SimCall[], traceTransfers: boolean): Promise<{ calls: RawSimCall[] } | { refused: string } | null> {
  const body = { jsonrpc: "2.0", id: 1, method: "eth_simulateV1", params: [{ blockStateCalls: [{ calls: calls.map((c) => ({ from: c.from, to: c.to, data: c.data, value: `0x${c.value.toString(16)}` })) }], validation: false, traceTransfers }, "latest"] }
  for (const url of READ_RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
      const j = await r.json() as { result?: Array<{ calls: RawSimCall[] }>; error?: { code?: number; message?: string } }
      if (j.error) {
        if (j.error.code === -32601 || /not available|not supported|unknown method/i.test(j.error.message ?? "")) continue
        return { refused: (j.error.message ?? "simulation refused").slice(0, 200) }
      }
      const out = j.result?.[0]?.calls ?? []
      if (out.length !== calls.length) continue
      return { calls: out }
    } catch { continue }
  }
  return null
}

/** The pseudo-address eth_simulateV1's traceTransfers logs native-coin moves under (ERC-20 Transfer shape). */
const NATIVE_TRANSFER_LOG = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
/**
 * The HYPE the LAST call of a sequence pays to any of `recipients`, read off a simulation with traceTransfers: the
 * exact output of a sell at the current state, for pools whose hook refuses the V4 Quoter (Montra and BOXA revert any
 * sell quote inside their hooks, while the same sell through the router goes through). Null when a call reverts or
 * no relay can simulate.
 */
export async function simulateNativeReceived(calls: SimCall[], recipients: Address[]): Promise<bigint | null> {
  const r = await simulateRaw(calls, true)
  if (!r || "refused" in r || r.calls.some((c) => c.status !== "0x1")) return null
  const to = new Set(recipients.map((a) => a.toLowerCase()))
  let total = 0n
  for (const l of r.calls[r.calls.length - 1].logs ?? []) {
    if (l.address.toLowerCase() !== NATIVE_TRANSFER_LOG || l.topics.length < 3) continue
    if (to.has(`0x${l.topics[2].slice(26)}`.toLowerCase())) total += BigInt(l.data)
  }
  return total
}

const DEFAULT_RPCS = ["https://rpc.elysium.kinetiq.xyz", "https://rpc.agoradex.app", "https://rpc.volta.family", "https://rpc.thekleos.pro/rpc", "https://rpc-live.elysp.com"]
// a browser (demo mode) has no server env: the defaults
const envList = (k: string) => ((typeof process !== "undefined" && process.env ? process.env[k] : "") || "").split(",").map((s) => s.trim()).filter((u) => /^https:\/\//.test(u))

/** Every relay a signed transaction is broadcast to. */
export const SEND_RPCS: string[] = envList("ELYSIUM_RPC_URLS").length ? envList("ELYSIUM_RPC_URLS") : DEFAULT_RPCS
/** The relays reads run over: the ones that answered at full speed. ElysPump throttles, so it only backs the others up. */
export const READ_RPCS: string[] = envList("ELYSIUM_READ_RPC_URLS").length ? envList("ELYSIUM_READ_RPC_URLS") : SEND_RPCS.filter((u) => !/elysp\.com/.test(u)).concat(SEND_RPCS.filter((u) => /elysp\.com/.test(u)))

export const elysium = defineChain({
  id: ELYSIUM_CHAIN_ID,
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: READ_RPCS } },
  blockExplorers: { default: { name: "Elyscan", url: "https://elyscan.live" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
})

export const ADDR = {
  whype: "0xbA876237B0F021A6c6D852d6c26E107997cC5E81" as Address,
  usdc: "0xb47c4C8F3cA1b4b4A5B5bFfE6b2b2fE3B19F6f0a" as Address,
  poolManager: "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1" as Address,
  universalRouter: "0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a" as Address,
  quoter: "0x379F556c5a748BD7Cc9baF0F7A344094Ac1814f5" as Address,
  stateView: "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE" as Address,
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3" as Address,
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  // Ascend
  launchpad: "0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC" as Address,
  escrowFactory: "0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19" as Address,
  ruleSet: "0xA9a627729D04576D8f79E3279bd17429C7794712" as Address,
} as const

/** Relays that answer the cheap ping fast but stall or refuse real reads under load ("server busy", 2–5 s): never first. */
const PATIENT = /elysp\.com/
const PATIENT_KEY = "patient-relay"

/**
 * THE READ LADDER, RANKED. The public relays answer the same call anywhere from 200 ms to 8 s within a minute of each
 * other, and a fixed-order fallback only moves on after a timeout: one stalling relay held every read for seconds.
 * With `rank`, viem pings every relay every 20 s and reorders the ladder by latency and stability, so reads drift to
 * whichever relay is answering now. The ping is eth_blockNumber (not every relay answers viem's default
 * net_listening). A patient relay's ping is refused, so it ranks last and is reached only when every fast relay fails.
 * ONE fallback level, created once: a ranked fallback nested inside another starts a new ranker loop per request.
 * Sends are untouched: every signed transaction still goes to every relay at once (fanout-send.ts).
 */
function readTransport() {
  const transports = READ_RPCS.map((u) => http(u, { timeout: 4_000, retryCount: 0, batch: false, ...(PATIENT.test(u) ? { key: PATIENT_KEY } : {}) }))
  if (transports.length < 2) return fallback(transports, { retryCount: 1 })
  return fallback(transports, {
    retryCount: 1,
    rank: {
      interval: 20_000, sampleCount: 4, timeout: 1_500, weights: { latency: 0.6, stability: 0.4 },
      ping: ({ transport }) => (transport.config?.key === PATIENT_KEY ? Promise.reject(new Error("a patient relay never leads the ladder")) : transport.request({ method: "eth_blockNumber" })),
    },
  })
}

/**
 * One public client over the read relays (ranked, see readTransport), 200 ms receipt polling (160 ms blocks). Kept on
 * the process (serverState), so a module loaded twice by the bundler still shares one client and one ranker.
 */
export function publicClient(): PublicClient {
  return appState("publicClient", () => createPublicClient({ chain: elysium, transport: readTransport(), pollingInterval: 200 }) as PublicClient)
}

/** Broadcast signed bytes to every send relay at once; the hash, however it was accepted. */
export async function sendRaw(raw: Hex): Promise<Hex> {
  const r = await fanoutSendRaw(SEND_RPCS, raw, { onRefusal: (url, err) => console.info(`[fanout] ${new URL(url).host}: ${err.slice(0, 80)}`) })
  console.info(`[fanout] ${r.acceptedBy ? `accepted by ${new URL(r.acceptedBy).host}` : "every relay already had it"} ${r.hash.slice(0, 12)}`)
  return r.hash
}

export const EXPLORER = "https://elyscan.live"
export const ASCEND_APP = "https://app.ascendlaunch.xyz"
export const txLink = (hash: string) => `${EXPLORER}/tx/${hash}`
export const addressLink = (a: string) => `${EXPLORER}/address/${a}`
export const tokenLink = (t: string) => `${EXPLORER}/token/${t}`
export const ascendToken = (t: string) => `${ASCEND_APP}/tokens/${t.toLowerCase()}`

/** A plain HYPE transfer on an Orbit chain needs the L1 data fee folded into gas: 200k is the floor, the real estimate is ~142k. */
export const TRANSFER_GAS = 200_000n
