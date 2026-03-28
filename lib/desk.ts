/**
 * Desk actions on the wallet folder: the shared ones (lib/core/desk-ops.ts) bound to the folder store and this
 * server's chain client.
 */
import { createDeskOps } from "./core/desk-ops"
import { chainApi } from "./settings"
import { walletStore } from "./wallets"

export type { DeskStatus } from "./core/desk-ops"
export const { deskStatus, deployDesk, upgradeDesk, fundDesk, withdrawDeskHype, withdrawDeskToken } = createDeskOps({ api: chainApi, wallets: walletStore })
