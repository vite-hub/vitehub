/** The Forges that have a Channel and the `forge()` Capability. `useForge()` from `vite-hub/forge` also reaches Gitea. */
export const agentForges = ["github", "gitlab", "forgejo"] as const

export type ForgeKind = typeof agentForges[number]
