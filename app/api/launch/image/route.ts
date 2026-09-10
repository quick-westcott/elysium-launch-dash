import { fail, isAddress, ok } from "@/lib/http"
import { chainApi } from "@/lib/settings"
import { exportKeys, mainWallet } from "@/lib/wallets"

/**
 * POST /api/launch/image (multipart: file, name, symbol, description?, twitter?, telegram?, website?, creator?, wallets?)
 * → the image pinned on IPFS and Ascend's metadata JSON pinned around it → { image, metadataUri, sealed }. `wallets`
 * is a JSON array of the launch's addresses: their keys ride the JSON as a sealed launch stamp when the files exist.
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
      // per wallet: a launch that resolved its rows first has them all, and one
      // stray address must not cost the whole record
      const symbol = String(form.get("symbol") ?? "") || "coin"
      const star = mainWallet()?.publicKey?.toLowerCase()
      const found = list.flatMap((pk) => { try { return exportKeys([pk]) } catch { return [] } })
      if (found.length) recovery = found.map((k) => ({
        publicKey: k.publicKey, secret: k.privateKey,
        label: k.publicKey.toLowerCase() === star ? `Funder - ${symbol}` : k.label,
      }))
    } catch { recovery = undefined }
    const r = await chainApi().uploadMetadata(form, (isAddress(creator) ? creator : mainWallet()?.publicKey) as `0x${string}` | undefined, recovery)
    return ok({ image: r.metadata.image, metadataUri: r.metadataUri, sealed: r.sealed ?? 0 })
  } catch (e) {
    return fail(e)
  }
}
