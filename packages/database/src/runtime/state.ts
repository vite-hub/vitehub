import { getStandardContext } from "@vite-hub/runtime/h3"

import type { ViteHubContext } from "@vite-hub/runtime"

export { runWithActiveCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
export { runWithDatabaseRequest } from "./d1-sessions.ts"

/** The Cloudflare bindings in the Standard Context of a request event, when the host provides them. */
export function getRequestCloudflareEnv(event: ViteHubContext): Record<string, unknown> | undefined {
  return getStandardContext(event).runtime?.cloudflare?.env
}
