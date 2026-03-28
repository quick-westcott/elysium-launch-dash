// Two ways to dry-run a wrap → approve → create sequence on a relay, read-only:
//   1. eth_simulateV1 (sequential calls, state carried between them)        node research/probe-override.mjs sim [rpc]
//   2. eth_call with a state override on WHYPE's balance/allowance slots    node research/probe-override.mjs slots [rpc]
import { keccak256, encodeAbiParameters, pad, toHex } from "viem"
const WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81"
const PM = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1"
const DEV = "0x4ed9E9337d0F968c00b1c664aE7D4afcF1b78f63"
const mode = process.argv[2] || "sim"
const url = process.argv[3] || "https://rpc.agoradex.app"
const rpc = async (method, params) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json())
const mapSlot = (key, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]))
const balOf = (who) => "0x70a08231" + who.slice(2).toLowerCase().padStart(64, "0")

if (mode === "sim") {
  // deposit() then balanceOf(dev): if the second call sees the first, the relay simulates sequences
  const r = await rpc("eth_simulateV1", [{ blockStateCalls: [{ calls: [
    { from: DEV, to: WHYPE, data: "0xd0e30db0", value: toHex(10n ** 16n) },
    { from: DEV, to: WHYPE, data: balOf(DEV) },
  ] }], validation: false, traceTransfers: false }, "latest"])
  if (r.error) console.log(url, "eth_simulateV1 →", JSON.stringify(r.error))
  else {
    const calls = r.result?.[0]?.calls ?? []
    console.log(url, "eth_simulateV1 ok:", calls.map((c) => c.status + (c.returnData && c.returnData !== "0x" ? ` ret=${Number(BigInt(c.returnData)) / 1e18}` : "") + (c.error ? ` err=${JSON.stringify(c.error).slice(0, 80)}` : "")).join(" · "))
  }
  const real = BigInt((await rpc("eth_call", [{ to: WHYPE, data: balOf(DEV) }, "latest"])).result)
  console.log("  (dev's real WHYPE now:", real / 10n ** 18n, "— the simulated 0.01 HYPE deposit should show +0.01 in the sim)")
} else {
  const real = BigInt((await rpc("eth_call", [{ to: WHYPE, data: balOf(PM) }, "latest"])).result)
  console.log(url, "balanceOf(PoolManager) =", real / 10n ** 18n, "WHYPE")
  const code = (await rpc("eth_getCode", [WHYPE, "latest"])).result ?? "0x"
  console.log("  code bytes:", (code.length - 2) / 2, code.includes("363d3d373d3d3d363d73") ? "(minimal proxy)" : "")
  const candidates = []
  for (let s = 0n; s < 20n; s++) candidates.push([`plain ${s}`, s])
  const oz = BigInt("0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00") // OZ v5 ERC20Storage (ERC-7201)
  candidates.push(["oz7201 balances", oz], ["oz7201 +1", oz + 1n])
  for (const [name, s] of candidates) {
    const v = (await rpc("eth_getStorageAt", [WHYPE, mapSlot(PM, s), "latest"])).result
    if (v && BigInt(v) === real && real > 0n) {
      console.log("  balanceOf mapping found at", name)
      const want = 123n * 10n ** 18n
      const over = await rpc("eth_call", [{ to: WHYPE, data: balOf(DEV) }, "latest", { [WHYPE]: { stateDiff: { [mapSlot(DEV, s)]: pad(toHex(want), { size: 32 }) } } }])
      console.log("  override balanceOf(dev) =", over.result ? BigInt(over.result) / 10n ** 18n + " (want 123)" : JSON.stringify(over.error))
      process.exit(0)
    }
  }
  console.log("  no candidate slot matched")
}
