/**
 * Moving HYPE between the app's wallets, all refusing a wallet that is not backed up (assertBackedUp).
 *
 *   fundDirect   funding wallet → each wallet, a plain transfer signed with the funding wallet's account data
 *   gather       each wallet → funding wallet: balance minus a gas reserve
 *   sendDirect   each wallet → any address
 */
import { AppError } from "./errors"
import { Nonces, signTx, toEth, toWei, transferGasEth, transferTx, waitSuccess } from "./evm"
import type { Env } from "./env"
import type { WalletInfo } from "./wallet-record"

/** Left in a wallet when gathering: one plain transfer's gas at today's prices, at least this. */
export const GATHER_RESERVE_ETH = 0.0001

export type FundResult = { publicKey: string; eth: number; hash?: string; confirmed?: boolean; error?: string; code?: string }

function requireFunding(env: Env): WalletInfo {
  const f = env.wallets.main()
  if (!f) throw new AppError("No ★ wallet yet: create or import one on the Wallets page first", "no_funding_wallet", 400)
  env.wallets.assertBackedUp(f.publicKey)
  return f
}

/** Funding wallet → each target. Nothing is sent when any key is not backed up or the balance is short. */
export async function fundDirect(env: Env, targets: Array<{ publicKey: string; eth: number }>): Promise<{ from: string; results: FundResult[] }> {
  const funding = requireFunding(env)
  for (const t of targets) env.wallets.assertBackedUp(t.publicKey)
  const api = env.api
  const account = env.wallets.accountOf(funding.publicKey)
  const acct = await api.rh.account(funding.publicKey)
  const total = targets.reduce((a, t) => a + t.eth, 0) + transferGasEth(acct) * targets.length
  if (Number(acct.balanceEth) < total) throw new AppError(`Funding wallet holds ${acct.balanceEth} HYPE; ${total.toFixed(6)} HYPE is needed (${targets.length} transfers + gas)`, "insufficient_funds", 409, `Send HYPE to ${funding.publicKey} first`)
  const nonces = new Nonces(acct)
  const results: FundResult[] = []
  for (const t of targets) {
    try {
      const raw = await signTx(account, acct, nonces, transferTx(t.publicKey, t.eth, acct))
      const { hash } = await api.rh.send(raw)
      results.push({ publicKey: t.publicKey, eth: t.eth, hash })
    } catch (e) {
      results.push({ publicKey: t.publicKey, eth: t.eth, error: e instanceof Error ? e.message : String(e), code: (e as { code?: string })?.code })
      break
    }
  }
  for (const r of results) if (r.hash) r.confirmed = await waitSuccess(api, r.hash, 60_000).catch(() => false)
  return { from: funding.publicKey, results }
}

/** Each wallet → the funding wallet: everything but a gas reserve. */
export async function gather(env: Env, publicKeys: string[]): Promise<{ to: string; results: Array<FundResult & { skipped?: string }> }> {
  const funding = requireFunding(env)
  return sendDirect(env, publicKeys, funding.publicKey, "max")
}

/** Each wallet → `to`: `amount` HYPE, or "max" = the balance minus exactly the transfer's gas (+25 % margin). */
export async function sendDirect(env: Env, publicKeys: string[], to: string, amount: number | "max"): Promise<{ to: string; results: Array<FundResult & { skipped?: string }> }> {
  for (const pk of publicKeys) env.wallets.assertBackedUp(pk)
  const api = env.api
  const results: Array<FundResult & { skipped?: string }> = []
  for (const pk of publicKeys) {
    if (pk.toLowerCase() === to.toLowerCase()) { results.push({ publicKey: pk, eth: 0, skipped: "is the destination" }); continue }
    try {
      const acct = await api.rh.account(pk)
      const gasWei = BigInt(acct.transferGas || 200000) * BigInt(acct.maxFeePerGas)
      const reserve = (gasWei * 125n) / 100n
      const balance = toWei(acct.balanceEth)
      const value = amount === "max" ? balance - reserve : toWei(amount)
      if (value <= 0n) { results.push({ publicKey: pk, eth: 0, skipped: `holds ${acct.balanceEth} HYPE, not even the transfer's gas (${toEth(reserve).toFixed(8)})` }); continue }
      if (value + reserve > balance) { results.push({ publicKey: pk, eth: 0, error: `holds ${acct.balanceEth} HYPE; ${toEth(value)} + gas ${toEth(reserve).toFixed(8)} is more than that (use Max)` }); continue }
      const raw = await signTx(env.wallets.accountOf(pk), acct, new Nonces(acct), { label: "transfer", to, data: "0x", value: value.toString(), gas: acct.transferGas })
      const { hash } = await api.rh.send(raw)
      results.push({ publicKey: pk, eth: toEth(value), hash })
    } catch (e) {
      results.push({ publicKey: pk, eth: 0, error: e instanceof Error ? e.message : String(e), code: (e as { code?: string })?.code })
    }
  }
  for (const r of results) if (r.hash) r.confirmed = await waitSuccess(api, r.hash, 60_000).catch(() => false)
  return { to, results }
}
