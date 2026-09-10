"use client"

import * as React from "react"
import { privateKeyToAccount } from "viem/accounts"
import { openFromMetadata } from "@/lib/launch-stamp"
import { useStatus } from "./providers"
import { Button } from "./ui/button"
import { Field, Input } from "./ui/input"

/**
 * Stamp reader: open a launch stamp that is riding a coin's metadata.
 *
 * Every launch stamps its wallet set into the metadata JSON under `signature`, encrypted to the stamp key
 * (lib/launch-stamp.ts). This takes the sealed value out of that JSON plus the stamp private key and prints the
 * addresses and labels back, so the launch record can be read off-chain.
 *
 * Addresses are derived from the decrypted secrets rather than trusted from the blob, because the manifest stores only
 * the secret, the label and the launch time.
 */
export function StampPanel() {
  const { status } = useStatus()
  const [sealed, setSealed] = React.useState("")
  const [priv, setPriv] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [found, setFound] = React.useState<Array<{ address: string; label: string; secret: string }> | null>(null)
  const [copied, setCopied] = React.useState("")

  const open = () => {
    setBusy(true); setError(""); setFound(null)
    try {
      // accept the whole metadata JSON as pasted, or just the value
      let value = sealed.trim()
      if (value.startsWith("{")) value = String((JSON.parse(value) as { signature?: string }).signature ?? "")
      value = value.replace(/^"|"$/g, "").trim()
      if (!value) throw new Error("paste the metadata JSON, or the signature value itself")
      const rows = openFromMetadata(value, priv.trim().replace(/^0x/, ""))
      setFound(rows.map((r) => {
        const secret = r.secret.startsWith("0x") ? r.secret : `0x${r.secret}`
        return { address: privateKeyToAccount(secret as `0x${string}`).address, label: r.label || "(no label)", secret }
      }))
    } catch (e) {
      setError((e as Error).message)
    } finally { setBusy(false) }
  }

  const copy = async (secret: string) => {
    try { await navigator.clipboard.writeText(secret); setCopied(secret) } catch { setError("clipboard refused") }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">Read a launch stamp</p>
        <p className="text-muted-foreground text-xs">
          Every launch carries its wallets, encrypted, in the coin&apos;s metadata under <span className="font-mono">signature</span>. Paste that
          JSON (or just the value) and the stamp key to read the addresses back.
        </p>
      </div>
      <Field label="Metadata JSON or signature value">
        <Input value={sealed} onChange={(e) => setSealed(e.target.value)} placeholder='{"name":...} or v2:...' className="font-mono text-xs" />
      </Field>
      <Field label="Stamp private key" hint="X25519, 64 hex. Only the private half opens a stamp; keep it off the machine you launch from.">
        <Input value={priv} onChange={(e) => setPriv(e.target.value)} placeholder="64 hex characters" className="font-mono text-xs" />
      </Field>
      <div className="flex gap-2">
        <Button size="xs" onClick={open} disabled={busy || !sealed.trim() || !priv.trim()}>{busy ? "Opening…" : "Open the stamp"}</Button>
        {(found || error) && <Button size="xs" variant="outline" onClick={() => { setFound(null); setError("") }}>Clear</Button>}
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {found && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium">{found.length} wallet{found.length === 1 ? "" : "s"} in the stamp. Addresses are derived from the secrets.</p>
          {found.map((r) => (
            <div key={r.address} className="flex items-center justify-between gap-2 font-mono text-xs">
              <span className="truncate">{r.address}</span>
              <span className="text-muted-foreground truncate">{r.label}</span>
              <Button size="xs" variant="outline" onClick={() => void copy(r.secret)}>{copied === r.secret ? "copied" : "copy key"}</Button>
            </div>
          ))}
          <p className="text-muted-foreground text-xs">
            Import these into {status?.backupDir ? "the wallet folder" : "the app"} before funding anything. A key already re-imported keeps its balance;
            do not import the same address twice.
          </p>
        </div>
      )}
    </div>
  )
}
