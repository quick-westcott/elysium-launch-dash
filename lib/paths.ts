/**
 * Where this app keeps its files. There is exactly one folder: the wallet backup folder.
 *
 *   WALLET_BACKUP_DIR     when set (point every starter at one folder to share wallets)
 *   ./wallets             otherwise: inside the cloned repo (git-ignored), next to the code that uses it
 *
 * Wallet files live at its top level (one JSON per wallet + wallets.csv); sibling starters share the folder, each
 * tagging its files with a `chain`. This app's own state sits in `_app/elysium-starter/`: settings.json,
 * launches.json, desks.json (which wallet owns which desk) and exits.json (the armed auto-sells).
 */
import fs from "node:fs"
import path from "node:path"
import { setKV } from "./kv"

export const BACKUP_DIR: string = (() => {
  const env = (process.env.WALLET_BACKUP_DIR || "").trim()
  if (env) return path.resolve(env)
  return path.join(process.cwd(), "wallets")
})()

export const APP_DIR = path.join(BACKUP_DIR, "_app", "elysium-starter")
export const SETTINGS_FILE = path.join(APP_DIR, "settings.json")
export const LAUNCHES_FILE = path.join(APP_DIR, "launches.json")
export const DESKS_FILE = path.join(APP_DIR, "desks.json")
export const EXITS_FILE = path.join(APP_DIR, "exits.json")

/** Create the folders (idempotent). */
export function ensureDirs(): void {
  fs.mkdirSync(APP_DIR, { recursive: true })
}

/** Read a JSON file, or the fallback when it is missing or unreadable. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

/** Write a JSON file atomically (write a temp file, then rename over the old one). */
export function writeJson(file: string, data: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode })
  fs.renameSync(tmp, file)
}

/** Server state that must survive a dev-server hot reload: see lib/state.ts (kept here under its old name). */
export { appState as serverState } from "./state"

// The chain layer's records (desks.json, exits.json) are files in APP_DIR on the server (lib/kv.ts is the seam).
setKV({
  read: <T,>(name: string, fallback: T): T => readJson<T>(path.join(APP_DIR, `${name}.json`), fallback),
  write: (name: string, value: unknown): void => writeJson(path.join(APP_DIR, `${name}.json`), value),
})
