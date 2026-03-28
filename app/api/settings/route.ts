import { body, fail, ok } from "@/lib/http"
import { BACKUP_DIR } from "@/lib/paths"
import { chainApi, effectiveSettings, updateSettings, type Settings } from "@/lib/settings"
import { READ_RPCS, SEND_RPCS } from "@/lib/elysium/chain"
import { pinningConfigured } from "@/lib/elysium/pin"
import { fundingWallet } from "@/lib/wallets"

export const dynamic = "force-dynamic"

/**
 * GET /api/settings → the effective settings, the backup folder, the funding wallet and the connection check: the
 * chain's id read through the relays → status "connected" | "error". No API key: this app talks to Elysium itself.
 */
export async function GET() {
  const s = effectiveSettings()
  let status: "connected" | "no_key" | "error" = "error"
  let error: { error: string; code?: string } | undefined
  let block: number | undefined
  try {
    const me = await chainApi().me()
    if (me.chainId !== 99901) throw new Error(`the relays answer chain ${me.chainId}, not Elysium (99901)`)
    status = "connected"
    block = (await chainApi().rh.account("0x0000000000000000000000000000000000000001")).block
  } catch (e) {
    error = { error: e instanceof Error ? e.message : String(e), code: "unreachable" }
  }
  return ok({
    apiUrl: SEND_RPCS[0] ?? "", apiKeyMasked: "", apiKeyFrom: "none" as const,
    slippage: s.slippage, sniperGapMs: s.sniperGapMs, holderWindowS: s.holderWindowS, holderDelayS: s.holderDelayS, feePpm: s.feePpm,
    backupDir: BACKUP_DIR, funding: fundingWallet(), status, keyPrefix: status === "connected" ? `block ${block}` : undefined, error,
    createKeyUrl: "", relays: { send: SEND_RPCS, read: READ_RPCS }, pinning: pinningConfigured(),
  })
}

/** PUT /api/settings { slippage?, sniperGapMs?, holderWindowS?, holderDelayS?, feePpm?, mainWallet? } → saved to _app/elysium-starter/settings.json. null clears a field. */
export async function PUT(req: Request) {
  const b = await body<{ [K in keyof Settings]: Settings[K] | null }>(req)
  try {
    updateSettings(b)
    return GET()
  } catch (e) {
    return fail(e)
  }
}
