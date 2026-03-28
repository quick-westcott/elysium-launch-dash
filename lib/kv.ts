/**
 * The small records the chain layer keeps (which wallet owns which desk, the armed auto-sell rules), behind one seam:
 * JSON files in `_app/elysium-starter/` on the server (lib/paths.ts registers them), localStorage in the browser
 * engine of demo mode. No node imports.
 */
import { appState } from "./state"

export type KV = { read<T>(name: string, fallback: T): T; write(name: string, value: unknown): void }

const slot = appState<{ kv: KV | null }>("kv", () => ({ kv: null }))

/** Register where the records live (once per process / tab). */
export function setKV(kv: KV): void {
  slot.kv = kv
}

/** localStorage under `prefix`; reads fall back on a missing or unreadable entry, a refused write throws. */
export function localStorageKV(prefix: string): KV {
  return {
    read<T>(name: string, fallback: T): T {
      try {
        const raw = window.localStorage.getItem(`${prefix}.${name}`)
        return raw === null ? fallback : (JSON.parse(raw) as T)
      } catch {
        return fallback
      }
    },
    write(name: string, value: unknown): void {
      try {
        window.localStorage.setItem(`${prefix}.${name}`, JSON.stringify(value))
      } catch (e) {
        throw new Error(`This browser refused to store the data (${e instanceof Error ? e.message : e})`)
      }
    },
  }
}

/** The registered store. In a browser with none registered yet: localStorage. On a server: lib/paths.ts must be loaded. */
export function kv(): KV {
  if (slot.kv) return slot.kv
  if (typeof window !== "undefined") return (slot.kv = localStorageKV("trenchytools.elysium-starter"))
  throw new Error("no record store registered: import lib/paths.ts on the server")
}
