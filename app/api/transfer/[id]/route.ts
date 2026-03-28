/** There is no exchange hop on Elysium. */
export async function GET() {
  return Response.json({ error: "No exchange transfers on Elysium", code: "not_available" }, { status: 410 })
}
