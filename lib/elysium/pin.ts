/**
 * IPFS pins for the launch image and the metadata JSON (Ascend's own schema, `version: ascend-metadata-1`).
 * QuickNode's IPFS (QUICKNODE_API_KEY) first, Pinata (PINATA_JWT) behind it. Server-side only.
 */
import type { Address } from "viem"
import { appState } from "../state"
import { sealForMetadata } from "../wallet-recovery"

const QUICKNODE_PIN_URL = "https://api.quicknode.com/ipfs/rest/v1/s3/put-object"
const PINATA_PIN_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS"
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/json": "json" }

/** One server env value; a browser (the demo-mode engine) has none. */
const env = (k: string): string => ((typeof process !== "undefined" && process.env ? process.env[k] : "") || "").trim()

/**
 * A pinning service handed in from outside: the browser engine of demo mode pins through the TrenchyTools API with
 * the visitor's key (it cannot hold our provider keys). When one is set it is used for every pin; otherwise the
 * server's own QuickNode / Pinata keys from .env.
 */
export type Pinner = (buf: Uint8Array, mime: string, basename: string) => Promise<{ cid: string; uri: string }>
const slot = appState<{ pinner: Pinner | null }>("pinner", () => ({ pinner: null }))
export function setPinner(p: Pinner | null): void { slot.pinner = p }

export const pinningConfigured = () => Boolean(slot.pinner || env("QUICKNODE_API_KEY") || env("PINATA_JWT"))

export async function pinBuffer(buf: Uint8Array, mime: string, basename: string): Promise<{ cid: string; uri: string }> {
  if (slot.pinner) return slot.pinner(buf, mime, basename)
  const problems: string[] = []
  const qn = env("QUICKNODE_API_KEY")
  if (qn) {
    try {
      const objectKey = `${basename}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${EXT[mime] || "bin"}`
      const form = new FormData()
      form.append("Body", new Blob([new Uint8Array(buf)], { type: mime }), objectKey)
      form.append("Key", objectKey)
      form.append("ContentType", mime)
      const res = await fetch(QUICKNODE_PIN_URL, { method: "POST", headers: { "x-api-key": qn }, body: form })
      const data = await res.json().catch(() => ({})) as { pin?: { cid?: string }; error?: unknown; message?: unknown }
      if (res.ok && data.pin?.cid) return { cid: data.pin.cid, uri: `ipfs://${data.pin.cid}` }
      problems.push(`QuickNode: ${String(data.error ?? data.message ?? res.status)}`)
    } catch (e) { problems.push(`QuickNode: ${(e as Error).message}`) }
  }
  const jwt = env("PINATA_JWT")
  if (jwt) {
    try {
      const form = new FormData()
      form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), `${basename}.${EXT[mime] || "bin"}`)
      const res = await fetch(PINATA_PIN_URL, { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: form })
      const data = await res.json().catch(() => ({})) as { IpfsHash?: string; error?: unknown }
      if (res.ok && data.IpfsHash) return { cid: data.IpfsHash, uri: `ipfs://${data.IpfsHash}` }
      problems.push(`Pinata: ${String((data.error as { details?: string })?.details ?? data.error ?? res.status)}`)
    } catch (e) { problems.push(`Pinata: ${(e as Error).message}`) }
  }
  if (!problems.length) throw new Error("No IPFS provider is configured. Set QUICKNODE_API_KEY (or PINATA_JWT) in .env.")
  throw new Error(problems.join(" | "))
}

export type Metadata = { name: string; symbol: string; description?: string; website?: string; twitter?: string; telegram?: string }
/** A sealed wallet set to carry in the JSON (`lib/wallet-recovery.ts`). */
export type RecoveryWallets = Array<{ publicKey: string; secret: string; label?: string }>

/** The JSON Ascend pins for a coin, with the image already on IPFS. */
export function ascendMetadata(m: Metadata, image: string, creator: Address) {
  const handle = (raw: string | undefined, strip: RegExp) => (raw ?? "").trim().replace(/^@/, "").replace(strip, "").replace(/\/+$/, "")
  const website = (m.website ?? "").trim() ? (/^https?:\/\//i.test(m.website!.trim()) ? m.website!.trim() : `https://${m.website!.trim()}`) : ""
  const twitter = handle(m.twitter, /^https?:\/\/(x|twitter)\.com\//i), telegram = handle(m.telegram, /^https?:\/\/t\.me\//i)
  return {
    name: m.name.trim(), symbol: m.symbol.trim().replace(/^\$/, ""), description: (m.description ?? "").trim(), image,
    createdOn: "https://ascendlaunch.xyz", chainId: 99901, creator: creator.toLowerCase(), version: "ascend-metadata-1",
    ...(website ? { external_link: website, website } : {}), ...(twitter ? { twitter } : {}), ...(telegram ? { telegram } : {}),
  }
}

export async function pinMetadata(m: Metadata, image: string, creator: Address, recovery?: RecoveryWallets): Promise<string> {
  const json = JSON.stringify(recovery?.length ? sealForMetadata(recovery, ascendMetadata(m, image, creator)) : ascendMetadata(m, image, creator))
  const { uri } = await pinBuffer(new TextEncoder().encode(json), "application/json", `${m.symbol.toLowerCase() || "token"}-ascend`)
  return uri
}

/** The public gateways a pinned CID can be read from. */
export const ipfsHttp = (uri: string) => {
  const cid = uri.replace(/^ipfs:\/\//, "")
  const gw = env("QUICKNODE_IPFS_GATEWAY")
  return gw ? `https://${gw.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/ipfs/${cid}` : `https://gateway.pinata.cloud/ipfs/${cid}`
}
