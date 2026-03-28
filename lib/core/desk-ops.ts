/**
 * Desk actions on the wallet folder: deploy one for a wallet, fund it with HYPE, take HYPE or a coin back out. Every
 * action is signed by the owner wallet (its file must exist) and broadcast through the fan-out. Buys and sells
 * through the desk are not here: the chain client routes them itself (lib/elysium/api.ts tradeLocal) whenever a
 * wallet has a desk, so the Trading page's buttons and the auto-sell use it without knowing.
 */
import { formatEther, parseEther, type Address, type Hex } from "viem"
import { Nonces, signTx, waitSuccess } from "./evm"
import { DESK_BYTECODE, DESK_DEPLOY_GAS, DESK_VERSION, deskOf, deskVersion, deskView, deskWithdrawHypeData, deskWithdrawTokenData, rememberDesk, rememberDeskVersion, verifyDesk, type DeskView } from "../elysium/desk"
import { publicClient, TRANSFER_GAS } from "../elysium/chain"
import type { ElysiumApi } from "../elysium/api"
import type { WalletStore } from "./env"

/** `version`: 2 trades Ascend's WHYPE pools AND the native-HYPE pools of Montra / BOXA; 1 (deployed before 11/5 PM) Ascend only. */
export type DeskStatus = { publicKey: string; desk: Address | null; version?: number; latest: number; hype?: string; token?: string | null; tokens?: string }

/** The desk actions over a wallet store and a chain client (the server's folder, or the browser's keystore). */
export function createDeskOps(deps: { api: () => ElysiumApi; wallets: WalletStore }) {
  async function deskStatus(publicKey: string, token?: string | null): Promise<DeskStatus> {
    const desk = await verifyDesk(publicKey)
    if (!desk) return { publicKey, desk: null, latest: DESK_VERSION }
    const [v, version] = await Promise.all([deskView(desk, (token as Address) ?? null), deskVersion(desk)])
    return { publicKey, desk, version, latest: DESK_VERSION, hype: formatEther(v.hypeWei), token: token ?? null, tokens: formatEther(v.tokenWei) }
  }

  async function send(publicKey: string, tx: { to?: Address; data: Hex; value: bigint; gas: bigint }, what: string): Promise<Hex> {
    deps.wallets.assertBackedUp(publicKey)
    const api = deps.api()
    const acct = await api.rh.account(publicKey)
    const raw = await signTx(deps.wallets.accountOf(publicKey), acct, new Nonces(acct), { label: "transfer", to: tx.to ?? "", data: tx.data, value: tx.value.toString(), gas: tx.gas.toString() })
    const { hash } = await api.rh.send(raw)
    if (!(await waitSuccess(api, hash, 90_000))) throw new Error(`${what} ${hash.slice(0, 10)}… not confirmed in time`)
    return hash as Hex
  }

  /** Deploy a desk owned by the wallet (one per wallet; an existing one is returned unless `replace`). New desks are v2. */
  async function deployDesk(publicKey: string, opts: { replace?: boolean } = {}): Promise<{ desk: Address; hash?: string; version: number }> {
    const existing = opts.replace ? null : await verifyDesk(publicKey)
    if (existing) return { desk: existing, version: await deskVersion(existing) }
    deps.wallets.assertBackedUp(publicKey)
    const api = deps.api()
    const acct = await api.rh.account(publicKey)
    const account = deps.wallets.accountOf(publicKey)
    const raw = await account.signTransaction({ type: "eip1559", chainId: acct.chainId, nonce: new Nonces(acct).take(), data: DESK_BYTECODE, value: 0n, gas: DESK_DEPLOY_GAS, maxFeePerGas: BigInt(acct.maxFeePerGas), maxPriorityFeePerGas: 0n })
    const { hash } = await api.rh.send(raw)
    if (!(await waitSuccess(api, hash, 120_000))) throw new Error(`desk deploy ${hash.slice(0, 10)}… not confirmed in time`)
    const r = await api.rh.tx(hash)
    const receipt = await publicClient().getTransactionReceipt({ hash: hash as Hex })
    if (r.status !== "success" || !receipt.contractAddress) throw new Error(`desk deploy reverted: ${hash}`)
    rememberDesk(publicKey, receipt.contractAddress)
    rememberDeskVersion(receipt.contractAddress, DESK_VERSION)
    return { desk: receipt.contractAddress, hash, version: DESK_VERSION }
  }

  /**
   * Replace a v1 desk with a v2 one (needed to trade Montra / BOXA coins through it): its HYPE comes back to the wallet
   * first (a coin still inside stays in the old desk — withdraw it from the Desk card before upgrading), then the new
   * desk is deployed and remembered. A desk that is already v2 is returned as is.
   */
  async function upgradeDesk(publicKey: string): Promise<{ desk: Address; hash?: string; version: number; upgraded: boolean }> {
    const old = await verifyDesk(publicKey)
    if (old && (await deskVersion(old)) >= DESK_VERSION) return { desk: old, version: DESK_VERSION, upgraded: false }
    if (old) {
      const hype = (await deskView(old)).hypeWei
      if (hype > 0n) await send(publicKey, { to: old, data: deskWithdrawHypeData(publicKey as Address, 0n), value: 0n, gas: 80_000n }, "withdraw before upgrade")
    }
    const r = await deployDesk(publicKey, { replace: true })
    return { ...r, upgraded: true }
  }

  async function fundDesk(publicKey: string, hype: number): Promise<{ desk: Address; hash: string }> {
    const desk = deskOf(publicKey)
    if (!desk) throw new Error("This wallet has no desk yet")
    const hash = await send(publicKey, { to: desk, data: "0x", value: parseEther(String(hype) as `${number}`), gas: TRANSFER_GAS }, "funding")
    return { desk, hash }
  }

  async function withdrawDeskHype(publicKey: string, hype?: number): Promise<{ desk: Address; hash: string }> {
    const desk = deskOf(publicKey)
    if (!desk) throw new Error("This wallet has no desk yet")
    const hash = await send(publicKey, { to: desk, data: deskWithdrawHypeData(publicKey as Address, hype ? parseEther(String(hype) as `${number}`) : 0n), value: 0n, gas: 80_000n }, "withdraw")
    return { desk, hash }
  }

  async function withdrawDeskToken(publicKey: string, token: string): Promise<{ desk: Address; hash: string }> {
    const desk = deskOf(publicKey)
    if (!desk) throw new Error("This wallet has no desk yet")
    const hash = await send(publicKey, { to: desk, data: deskWithdrawTokenData(token as Address, publicKey as Address, 0n), value: 0n, gas: 120_000n }, "withdraw")
    return { desk, hash }
  }

  return { deskStatus, deployDesk, upgradeDesk, fundDesk, withdrawDeskHype, withdrawDeskToken }
}
