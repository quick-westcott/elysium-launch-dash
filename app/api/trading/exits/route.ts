import { body, fail, isAddress, num, ok } from "@/lib/http"
import { armExit, cancelExit, fireExit, listExits } from "@/lib/exits"
import { mainWallet } from "@/lib/wallets"

export const dynamic = "force-dynamic"

/** GET /api/trading/exits[?token=0x…] → { exits }: the auto-sell rules, newest first. */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token")
  return ok({ exits: listExits(isAddress(token) ? token : null) })
}

/** POST /api/trading/exits { token, usd?, nextBuyHype?, scope?, devWallet?, bars? } → arm (replaces the coin's armed rule). `bars`: { address: outside HYPE in } per wallet. */
export async function POST(req: Request) {
  const b = await body<{ token: string; usd: number; nextBuyHype: number; scope: "all" | "noDev"; devWallet: string; bars?: Record<string, number> }>(req)
  if (!isAddress(b.token)) return fail(new Error("token: a 0x address"), 400)
  try {
    const dev = isAddress(b.devWallet) ? b.devWallet : mainWallet()?.publicKey ?? ""
    return ok({ exit: armExit({ token: b.token, usd: num(b.usd, 0), nextBuyHype: num(b.nextBuyHype, 0), scope: b.scope === "noDev" ? "noDev" : "all", devWallet: dev, bars: b.bars && typeof b.bars === "object" ? b.bars : undefined }) })
  } catch (e) {
    return fail(e)
  }
}

/** PUT /api/trading/exits { id } → fire it now, by hand. */
export async function PUT(req: Request) {
  const b = await body<{ id: string }>(req)
  if (!b.id) return fail(new Error("id is required"), 400)
  try {
    const r = await fireExit(b.id)
    return r ? ok({ exit: r }) : fail(new Error("no such armed rule"), 404)
  } catch (e) {
    return fail(e)
  }
}

/** DELETE /api/trading/exits?id=… → cancel. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id")
  if (!id) return fail(new Error("id is required"), 400)
  const r = cancelExit(id)
  return r ? ok({ exit: r }) : fail(new Error("no such rule"), 404)
}
