import { forgeImportError } from "@vite-hub/internal/forge"

/**
 * `@vite-hub/forge`, an optional peer. The github(), gitlab(), and forgejo() Channels, the forge() Capability, and
 * forge access load it on their first Forge request, so an Agent without a Forge does not need it.
 */
export async function loadForge(): Promise<typeof import("@vite-hub/forge")> {
  // The import stays in the try, so esbuild leaves it for run time when the app did not install Forge.
  try {
    return await import("@vite-hub/forge")
  }
  catch (error) {
    throw forgeImportError(error, "A Forge Channel or the forge() Capability")
  }
}
