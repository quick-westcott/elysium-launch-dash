/** There is no exchange hop on Elysium: use POST /api/wallets/fund (plain transfers from the ★ wallet). */
export async function POST() {
  return Response.json({ error: "No exchange funding on Elysium; use Fund from ★ (plain transfers)", code: "not_available" }, { status: 410 })
}
