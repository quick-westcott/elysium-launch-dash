/**
 * What a launch does the moment its coin exists: follow its tape (the staggered buys' gates and the auto-sell read it)
 * and arm the auto-sell from the launch form, logging what was armed. Shared by the server (lib/launch.ts) and the
 * browser engine of demo mode.
 */
import type { LaunchForm, LaunchRecord, Log } from "./launch"
import type { ExitRule } from "./exits"

type ArmExit = (p: { token: string; usd: number; nextBuyHype: number; scope: "all" | "noDev"; devWallet: string; devReceiver?: string; bars?: Record<string, number> }) => ExitRule

export function onLiveArm(f: LaunchForm, record: LaunchRecord, log: Log, deps: { followToken: (token: string) => unknown; armExit: ArmExit }) {
  return (token: string, devReceiver: string, bars: Record<string, number>): void => {
  deps.followToken(token) // the tape poller starts now: the staggered buys' gates and the auto-sell read it
  const nBars = Object.keys(bars).length
  if (!f.exit) { log("exit", nBars ? "Auto-sell is off: the per-wallet bars are ignored (switch Auto-sell on to use them)" : "Auto-sell is off: nothing sells on its own", { level: "warn" }); return }
  if (!(f.exit.usd! > 0) && !(f.exit.nextBuyHype! > 0) && !nBars) { log("exit", "Auto-sell is on but has no rule: no dollar bar, no next-buy size, no per-wallet bar. Nothing sells on its own.", { level: "warn" }); return }
  try {
    const rule = deps.armExit({ token, usd: f.exit.usd ?? 0, nextBuyHype: f.exit.nextBuyHype ?? 0, scope: f.exit.scope ?? "all", devWallet: record.dev, devReceiver, bars })
    const barText = nBars ? `${rule.usd > 0 || rule.nextBuyHype > 0 ? " · " : ""}${nBars} wallet${nBars === 1 ? "" : "s"} with their own bar on outside HYPE in (${Object.values(bars).sort((a, b) => a - b).join(", ")} HYPE)` : ""
    log("exit", `Auto-sell armed: ${rule.usd > 0 ? `$${rule.usd} net outside in` : ""}${rule.usd > 0 && rule.nextBuyHype > 0 ? " or " : ""}${rule.nextBuyHype > 0 ? `the next outside buy ≥ ${rule.nextBuyHype} HYPE` : ""}${barText} → ${rule.scope === "noDev" ? "sell all, no dev" : "sell everything"}`, { level: "ok" })
  } catch (e) {
    log("exit", `Auto-sell could not be armed: ${e instanceof Error ? e.message : String(e)}`, { level: "error" })
  }
  }
}
