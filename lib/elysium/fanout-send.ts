/**
 * One signed transaction, every relay at once.
 *
 * Elysium has one sequencer and a row of community relays in front of it
 * (Agoradex, Volta, Kleos, ElysPump, BOXA). The sequencer orders by arrival
 * and includes a hash once, so the only thing a relay choice changes is how
 * fast the bytes get there, and on 11/5 that ranged from 170 ms to 4 s with
 * outright drops. So the raw bytes go to every relay in parallel and the first
 * acceptance wins.
 *
 * THE LOSERS LIE, AND THAT IS THE WHOLE DIFFICULTY. A relay that gets the tx
 * second answers with an error: "already known", "nonce too low", a relay's
 * own wording ("Missing or invalid parameters" on Agoradex, "earlier relay
 * reservations" on ElysPump). This launcher once retried a signed launch
 * across endpoints and reported a live coin as failed on the strength of such
 * an answer (2026-09-03, see clients.ts). So here: one acceptance is success;
 * when nobody accepts but somebody says "I have it", that is success too, and
 * the hash is the keccak of the bytes; only when every relay refuses for a
 * reason that is not "duplicate" does the send fail, with the most specific
 * reason. The caller confirms by receipt either way, never by a relay's word.
 */
import { keccak256, type Hex } from 'viem'

/** Error wordings that mean "the sequencer already has this transaction". */
const DUPLICATE = /already known|known transaction|already exists|already imported|nonce too low|replacement transaction underpriced|transaction underpriced|earlier relay reservations|duplicate/i
/** A relay's generic refusal that says nothing: never the reason reported when a better one exists. */
const GENERIC = /missing or invalid parameters|internal error|bad request|^HTTP \d+/i

export type FanoutFetch = (url: string, body: string, timeoutMs: number) => Promise<{ status: number; text: string }>

const defaultFetch: FanoutFetch = async (url, body, timeoutMs) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) })
  return { status: r.status, text: await r.text() }
}

export type FanoutResult = { hash: Hex; acceptedBy: string | null; refusals: Array<{ url: string; error: string }> }

/**
 * Broadcast `raw` to every url at once. Resolves on the first acceptance (or
 * the first "I already have it"); rejects only when every relay refused for a
 * real reason.
 */
export async function fanoutSendRaw(
  urls: readonly string[],
  raw: Hex,
  opts: { timeoutMs?: number; fetch?: FanoutFetch; onRefusal?: (url: string, error: string) => void } = {},
): Promise<FanoutResult> {
  if (!urls.length) throw new Error('No relay to broadcast through.')
  const doFetch = opts.fetch ?? defaultFetch
  const timeoutMs = opts.timeoutMs ?? 8_000
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })
  const expected = keccak256(raw)
  const refusals: Array<{ url: string; error: string }> = []

  const attempts = urls.map(async (url) => {
    let res: { status: number; text: string }
    try {
      res = await doFetch(url, body, timeoutMs)
    } catch (e) {
      throw Object.assign(new Error(`${url}: ${(e as Error).message}`), { url, kind: 'network' as const })
    }
    let json: { result?: unknown; error?: { message?: string } } | null = null
    try { json = JSON.parse(res.text) } catch { /* not JSON */ }
    if (json && typeof json.result === 'string' && /^0x[0-9a-f]{64}$/i.test(json.result)) {
      return { url, hash: json.result as Hex }
    }
    const message = json?.error?.message ? String(json.error.message) : `HTTP ${res.status} ${res.text.slice(0, 120)}`
    throw Object.assign(new Error(message), { url, kind: DUPLICATE.test(message) ? 'duplicate' as const : 'refused' as const })
  })

  try {
    const first = await Promise.any(attempts)
    // Everything else keeps running; refusals are recorded for the log, never awaited.
    for (const a of attempts) a.catch((e: Error & { url?: string }) => { if (e.url) { refusals.push({ url: e.url, error: e.message }); opts.onRefusal?.(e.url, e.message) } })
    return { hash: first.hash, acceptedBy: first.url, refusals }
  } catch (agg) {
    const errors = ((agg as AggregateError).errors ?? []) as Array<Error & { url?: string; kind?: 'network' | 'duplicate' | 'refused' }>
    for (const e of errors) { refusals.push({ url: e.url ?? '?', error: e.message }); opts.onRefusal?.(e.url ?? '?', e.message) }
    if (errors.some((e) => e.kind === 'duplicate')) return { hash: expected, acceptedBy: null, refusals }
    // The most specific refusal, not a relay's shrug and not a timeout, when there is one.
    const specific = errors.find((e) => e.kind === 'refused' && !GENERIC.test(e.message))
      ?? errors.find((e) => e.kind === 'refused')
      ?? errors[0]
    throw new Error(`Every relay refused the transaction: ${specific?.message ?? 'no answer'}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`)
  }
}
