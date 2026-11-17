import { importForge } from "@vite-hub/internal/forge"

/**
 * `@vite-hub/forge`, an optional peer. The github(), gitlab(), and forgejo() Channels, the forge() Capability, and
 * forge access load it on their first Forge request, so an Agent without a Forge does not need it.
 */
export async function loadForge(): Promise<typeof import("@vite-hub/forge")> {
  return await importForge(() => import("@vite-hub/forge"), "A Forge Channel or the forge() Capability")
}
