/**
 * Drops the writes that a Store keeps staged until `snapshot()`, so it loads the branch again on its next call. Only
 * the GitHub and Cloudflare Artifacts Stores stage writes. Other Stores write through and do not have it.
 */
export const workspaceStoreDiscard: unique symbol = Symbol.for("vitehub.workspace.storeDiscard")

export type WorkspaceStoreDiscardCarrier = {
  [workspaceStoreDiscard]?: () => Promise<void>
}
