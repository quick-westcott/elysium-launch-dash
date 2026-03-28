import { fail, isAddress, ok } from "@/lib/http"
import { chainApi } from "@/lib/settings"
import { exportKeys, mainWallet } from "@/lib/wallets"

/**
 * POST /api/launch/image (multipart: file, name, symbol, description?, twitter?, telegram?, website?, creator?, wallets?)
 * → the image pinned on IPFS and Ascend's metadata JSON pinned around it → { image, metadataUri, sealed }. `wallets`
 * is a JSON array of the launch's addresses: their keys ride the JSON as a sealed recovery record when the files exist.
 * The metadata URI rides the launch calldata; the image goes into the coin's record.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const file = form.get("file")
    if (!(file instanceof File) || !file.size) return fail(new Error("file: a PNG, JPG, GIF or WebP up to 4 MB"), 400)
    const creator = String(form.get("creator") ?? "")
    let recovery: Array<{ publicKey: string; secret: string; label?: string }> | undefined
    try {
      const addrs = JSON.parse(String(form.get("wallets") ?? "[]")) as unknown
      const list = (Array.isArray(addrs) ? addrs : []).filter((x): x is string => typeof x === "string" && isAddress(x))
      if (list.length) recovery = list.map((pk) => { const [k] = exportKeys([pk]); return { publicKey: k.publicKey, secret: k.privateKey, label: k.label } })
    } catch { recovery = undefined } // an unresolvable wallet set never blocks the pin
    const r = await chainApi().uploadMetadata(form, (isAddress(creator) ? creator : mainWallet()?.publicKey) as `0x${string}` | undefined, recovery)
    return ok({ image: r.metadata.image, metadataUri: r.metadataUri, sealed: r.sealed ?? 0 })
  } catch (e) {
    return fail(e)
  }
}
