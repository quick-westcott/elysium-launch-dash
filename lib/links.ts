/** Where things are seen: each launchpad's page of a coin, and Elyscan for Elysium. Shared by server and client. */
export const ASCEND_URL = "https://app.ascendlaunch.xyz"
export const MONTRA_URL = "https://montramarkets.xyz"
export const BOXA_URL = "https://boxa.club"
export const EXPLORER_URL = "https://elyscan.live"

export const ascendToken = (token: string) => `${ASCEND_URL}/tokens/${token.toLowerCase()}`
export const montraToken = (token: string) => `${MONTRA_URL}/token/${token.toLowerCase()}`
export const boxaToken = (token: string) => `${BOXA_URL}/token/${token.toLowerCase()}`
/** The launchpad's own page of a coin. */
export const padToken = (pad: "ascend" | "montra" | "boxa", token: string) => (pad === "montra" ? montraToken(token) : pad === "boxa" ? boxaToken(token) : ascendToken(token))
/** Kept under its old name for the shared pages. */
export const ponsToken = ascendToken
export const txLink = (hash: string) => `${EXPLORER_URL}/tx/${hash}`
export const addressLink = (address: string) => `${EXPLORER_URL}/address/${address}`
export const tokenLink = (token: string) => `${EXPLORER_URL}/token/${token}`

export const short = (s: string, n = 6) => (s.length > n * 2 + 3 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s)
