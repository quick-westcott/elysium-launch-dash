"use client"

import * as React from "react"
import { ApiErrorView } from "./api-error"
import { useStatus } from "./providers"
import { Button } from "./ui/button"
import { Field, Input } from "./ui/input"
import { Sheet } from "./ui/sheet"
import { StampPanel } from "./stamp-panel"
import { failureOf, put, type ApiFailure } from "@/lib/client"
import { DEMO, DEMO_KEY_LABEL } from "@/lib/browser/demo"

/**
 * API key (+ Connected check), slippage, launch timing, API URL under Advanced; the folder is read-only. Saved to
 * _app/elysium-starter/settings.json. Demo mode: the visitor's own key (created in this browser on the first visit, shown
 * masked, replaceable by pasting or "Create a new key"; a refusal is shown exactly as the API sent it), saved in this browser.
 */
export function SettingsSheet() {
  const { status, settingsOpen, setSettingsOpen, refresh } = useStatus()
  const [slippage, setSlippage] = React.useState("")
  const [gap, setGap] = React.useState("")
  const [window_, setWindow] = React.useState("")
  const [delay, setDelay] = React.useState("")
  const [advanced, setAdvanced] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState<ApiFailure | null>(null)

  React.useEffect(() => {
    if (!status) return
    setSlippage(String(status.slippage)); setGap(String(status.sniperGapMs)); setWindow(String(status.holderWindowS)); setDelay(String(status.holderDelayS))
  }, [status, settingsOpen])

  const save = async () => {
    setBusy(true); setFailure(null)
    try {
      // PUT /api/settings: an empty key keeps the current one; "clear" removes it (back to .env; demo: forgets it)
      await put("/api/settings", {
        slippage: Number(slippage) || null, sniperGapMs: Number(gap) || null, holderWindowS: Number(window_) || null, holderDelayS: Number(delay) || 0,
      })
      await refresh()
    } catch (e) { setFailure(failureOf(e)) } finally { setBusy(false) }
  }

  return (
    <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings" description={DEMO ? "Saved in this browser. Your API key was made for you on your first visit; it is yours alone." : "Saved in the wallet folder under _app/elysium-starter/settings.json; .env provides the defaults."}>
      <ApiErrorView failure={failure ?? status?.error ?? null} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Slippage %"><Input type="number" min={0} max={100} value={slippage} onChange={(e) => setSlippage(e.target.value)} /></Field>
        <Field label="Sniper gap (ms)"><Input type="number" min={0} value={gap} onChange={(e) => setGap(e.target.value)} /></Field>
        <Field label="Holder window (s)"><Input type="number" min={1} value={window_} onChange={(e) => setWindow(e.target.value)} /></Field>
        <Field label="Holder delay (s)"><Input type="number" min={0} value={delay} onChange={(e) => setDelay(e.target.value)} /></Field>
      </div>
      {DEMO ? (
        <Field label="Keys" hint="Every wallet lives in this browser only. Download backup saves the keys as a file; clearing this site's data deletes them.">
          <Input readOnly value={`${status?.backupDir ?? ""} (localStorage)`} className="font-mono text-xs" />
        </Field>
      ) : (
        <Field label="Backup folder (read-only)" hint="Set WALLET_BACKUP_DIR in .env to move it. Every wallet file lives here; nothing is funded without its file.">
          <Input readOnly value={status?.backupDir ?? ""} className="font-mono text-xs" />
        </Field>
      )}
      <div className="flex gap-2">
        <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        <Button variant="outline" onClick={() => void refresh()} disabled={busy}>Re-check the chain</Button>
      </div>
      <StampPanel />
    </Sheet>
  )
}
