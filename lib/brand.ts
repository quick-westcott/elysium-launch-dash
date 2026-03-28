/**
 * Which launchpad this copy of the starter is built around. One codebase ships as three repositories (Ascend, Montra,
 * BOXA): each published copy sets `PAD` below (scripts/publish-github.mjs rewrites that one line), and every copy
 * still launches and trades on all three. NEXT_PUBLIC_LAUNCHPAD=ascend|montra|boxa overrides it locally.
 * Client-safe (no node imports).
 */
import type { Launchpad } from "./chain"

const PAD: Launchpad = "ascend"

const pick = process.env.NEXT_PUBLIC_LAUNCHPAD
export const BRAND_PAD: Launchpad = pick === "ascend" || pick === "montra" || pick === "boxa" ? pick : PAD

export type Brand = {
  pad: Launchpad
  /** the words after the TrenchyTools wordmark: "elysium starter" in every edition (one multi-pad app; the user, 11/6) */
  tag: string
  /** the GitHub repository of this copy */
  repo: string
  /** the hosted demo of this copy (demo mode: wallets in the visitor's browser) */
  live: string
  description: string
}

const ORG = "https://github.com/Trenchy-Tools"
export const BRANDS: Record<Launchpad, Brand> = {
  ascend: {
    pad: "ascend", tag: "elysium starter", repo: `${ORG}/trenchytools-elysium-launcher`, live: "https://elysium.trenchy.tools",
    description: "Launch and trade Ascend coins on Elysium (Hyperliquid L2) straight from your machine: desks, pre-signed exits, fan-out sends. Montra and BOXA too.",
  },
  montra: {
    pad: "montra", tag: "elysium starter", repo: `${ORG}/trenchytools-montra-launcher`, live: "https://montra.trenchy.tools",
    description: "Launch and trade Montra coins on Elysium (Hyperliquid L2) straight from your machine: bundled buys, desks, pre-signed exits, fan-out sends. Ascend and BOXA too.",
  },
  boxa: {
    pad: "boxa", tag: "elysium starter", repo: `${ORG}/trenchytools-boxa-launcher`, live: "https://boxa.trenchy.tools",
    description: "Launch and trade BOXA coins on Elysium (Hyperliquid L2) straight from your machine: creator fee 0–5 %, bundled buys, desks, pre-signed exits. Ascend and Montra too.",
  },
}

export const BRAND: Brand = BRANDS[BRAND_PAD]
