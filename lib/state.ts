/**
 * State that must outlive its module: timers, launch logs, the trade feed, the exit watchers, the read client. Kept
 * on `globalThis`, so a dev-server hot reload (which re-creates module scope) and a bundler that loads a module twice
 * still share one. No node imports: the browser engine of demo mode uses it too (there `globalThis` is the tab).
 */
export function appState<T>(key: string, init: () => T): T {
  const g = globalThis as unknown as Record<string, T>
  const k = `__elysium_starter_${key}`
  if (!(k in g)) g[k] = init()
  return g[k]
}
