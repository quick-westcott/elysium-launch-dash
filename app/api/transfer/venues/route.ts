/** There is no exchange hop on Elysium: funding is by plain transfer (POST /api/wallets/fund). */
export async function GET() {
  return Response.json({ exchange: "off", checkedAt: null, venues: {}, note: "No exchange venues on Elysium; fund wallets by plain transfer." }, { status: 200 })
}
