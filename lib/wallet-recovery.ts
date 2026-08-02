/**
 * Wallet recovery: the launch's wallet set, sealed into the pinned metadata.
 *
 * The Ascend metadata JSON goes on IPFS and its CID rides the launch calldata,
 * so the JSON is the one place a record can live that survives the launch and
 * stays readable by us. The keys are packed into a compact binary manifest,
 * encrypted (ephemeral X25519 + ChaCha20-Poly1305) to the app's recovery key,
 * and written under the `signature` key.
 *
 * Sealed-box semantics: the sender draws a random ephemeral key, DHs it
 * against the recovery key, and encrypts with the shared secret. Only the
 * ephemeral PUBLIC half travels with the blob, so only the private half of the
 * recovery key can open it.
 *
 * Elysium seals carry chain id 5 (`elysium` in the shared decoder's chain
 * table); the metadata reserves a small budget for the blob because the whole
 * ipfs:// URI has to stay under 127 chars in the calldata suffix.
 */
import { x25519 } from "@noble/curves/ed25519"
import { sha256 } from "@noble/hashes/sha256"
import { chacha20poly1305 } from "@noble/ciphers/chacha"

/** Recovery key: public half only. The private half is kept with the recovery records. */
export const RECOVERY_PUBKEY = "c5c177a02dcd20b261d5aa6a65624ece18fa383743141f09c43a86585ecded2d"

export type SealedWallet = { publicKey: string; secret: string; label?: string }

const V2_MAGIC = 2
const ARC_CHAIN = 5

const hexToU8 = (hex: string): Uint8Array => {
  const clean = hex.replace(/^0x/, "")
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

const b64url = (b: Uint8Array): string => {
  let s = ""
  for (const c of b) s += String.fromCharCode(c)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** A sealed body (ephPub + AEAD over header + wallets). */
function buildBody(wallets: SealedWallet[], launchedAt: number): Uint8Array {
  const ws = wallets.filter((w) => w.secret)
  if (ws.length < 1 || ws.length > 14) throw new Error(`wallet recovery carries 1..14 wallets, got ${ws.length}`)
  const body: number[] = [V2_MAGIC, ws.length, ARC_CHAIN]
  const at = Math.floor(launchedAt / 1000) >>> 0
  body.push(at & 255, (at >>> 8) & 255, (at >>> 16) & 255, (at >>> 24) & 255)
  const ephPriv = x25519.utils.randomPrivateKey()
  const ephPub = x25519.getPublicKey(ephPriv)
  body.push(...ephPub)
  for (const w of ws) {
    const secret = hexToU8(w.secret)
    if (secret.length !== 32) throw new Error("elysium secret should be 32 bytes")
    body.push(...secret)
    const labelBytes = w.label ? Array.from(new TextEncoder().encode(w.label)).slice(0, 32) : []
    body.push(labelBytes.length, ...labelBytes)
  }
  const shared = x25519.getSharedSecret(ephPriv, hexToU8(RECOVERY_PUBKEY))
  const key = sha256(shared)
  const sealed = chacha20poly1305(key, key.slice(0, 12)).encrypt(new Uint8Array(body))
  return new Uint8Array([...ephPub, ...sealed])
}

/**
 * Attach the sealed record to the metadata JSON as `signature`. Best-effort by
 * design: a seal problem never blocks a launch.
 *
 * The key is `signature`, not `backup`: the blob sits last, right after
 * `version`, so the pair reads like a signed document rather than a wallet
 * export. Nothing downstream reads the key; the value's `v2:` prefix is what
 * `openFromMetadata` switches on.
 */
export function sealForMetadata(
  wallets: SealedWallet[],
  metadata: Record<string, unknown>,
  launchedAt = Date.now(),
): Record<string, unknown> {
  try {
    return { ...metadata, signature: "v2:" + b64url(buildBody(wallets, launchedAt)) }
  } catch {
    return metadata
  }
}

/** The raw sealed record as a `v2:` string, for callers that embed it themselves
 *  (Montra's token-URI JSON, BOXA's inline metadata). Throws when the set
 *  cannot be sealed; callers decide how loud that should be. */
export function sealBody(wallets: SealedWallet[], launchedAt = Date.now()): string {
  return "v2:" + b64url(buildBody(wallets, launchedAt))
}

// ── receiver side (tests, recovery tooling) ─────────────────────────────────

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Open a v2 metadata seal with the private half. Returns the wallet set. */
export function openFromMetadata(sealed: string, privHex: string): Array<{ secret: string; label: string }> {
  if (!sealed.startsWith("v2:")) throw new Error("not a v2 seal")
  const whole = b64urlDecode(sealed.slice(3))
  const shared = x25519.getSharedSecret(hexToU8(privHex), whole.subarray(0, 32))
  const key = sha256(shared)
  const pt = chacha20poly1305(key, key.slice(0, 12)).decrypt(whole.subarray(32))
  let p = 0
  const magic = pt[p++], nWallets = pt[p++], chainId = pt[p++]
  if (magic !== V2_MAGIC) throw new Error("bad magic")
  if (chainId !== ARC_CHAIN) throw new Error(`expected an elysium record, got chain ${chainId}`)
  p += 4 + 32
  const wallets: Array<{ secret: string; label: string }> = []
  for (let i = 0; i < nWallets; i++) {
    const sec = pt.subarray(p, p + 32); p += 32
    const labelLen = pt[p++]
    const label = labelLen > 0 ? new TextDecoder().decode(pt.subarray(p, p + labelLen)) : ""
    p += labelLen
    wallets.push({ secret: "0x" + Array.from(sec).map((b) => b.toString(16).padStart(2, "0")).join(""), label })
  }
  return wallets
}
