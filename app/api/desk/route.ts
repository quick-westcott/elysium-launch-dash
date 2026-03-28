import { body, fail, isAddress, num, ok } from "@/lib/http"
import { deployDesk, deskStatus, fundDesk, upgradeDesk, withdrawDeskHype, withdrawDeskToken } from "@/lib/desk"

export const dynamic = "force-dynamic"

/** GET /api/desk?wallet=0x…[&token=0x…] → { publicKey, desk | null, hype, tokens }: the wallet's desk and what it holds. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams
  const wallet = q.get("wallet"), token = q.get("token")
  if (!isAddress(wallet)) return fail(new Error("wallet: a 0x address"), 400)
  try {
    return ok(await deskStatus(wallet, isAddress(token) ? token : null))
  } catch (e) {
    return fail(e)
  }
}

/**
 * POST /api/desk { action: "deploy" | "upgrade" | "fund" | "withdrawHype" | "withdrawToken", publicKey, amount?, token? }.
 * deploy: one contract owned by the wallet (cents of gas), v2. upgrade: replace a v1 desk with a v2 (its HYPE comes
 * back first). fund: HYPE from the wallet into it. withdraw*: back out.
 */
export async function POST(req: Request) {
  const b = await body<{ action: string; publicKey: string; amount: number; token: string }>(req)
  if (!isAddress(b.publicKey)) return fail(new Error("publicKey: a 0x address"), 400)
  try {
    if (b.action === "deploy") return ok(await deployDesk(b.publicKey))
    if (b.action === "upgrade") return ok(await upgradeDesk(b.publicKey))
    if (b.action === "fund") return ok(await fundDesk(b.publicKey, num(b.amount, 0)))
    if (b.action === "withdrawHype") return ok(await withdrawDeskHype(b.publicKey, num(b.amount, 0) || undefined))
    if (b.action === "withdrawToken") { if (!isAddress(b.token)) return fail(new Error("token: a 0x address"), 400); return ok(await withdrawDeskToken(b.publicKey, b.token)) }
    return fail(new Error("action: deploy | upgrade | fund | withdrawHype | withdrawToken"), 400)
  } catch (e) {
    return fail(e)
  }
}
