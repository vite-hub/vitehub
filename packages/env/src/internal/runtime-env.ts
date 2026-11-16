import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import type { ViteHubContext, ViteHubStandardProps } from "@vite-hub/runtime"

export type RuntimeEnv = Record<string, unknown>

export function processEnv(): RuntimeEnv {
  return typeof process === "object" && process && process.env ? process.env : {}
}

/**
 * The Cloudflare bindings in the request's Standard Context, else the bindings of the active Cloudflare request.
 * Installs Standard Context on H3 events when needed. A value without an event request, such as Auth's `Request`,
 * reads the active bindings.
 */
export function cloudflareEnv(event?: Request | ViteHubContext): RuntimeEnv | undefined {
  if (!event) return getActiveCloudflareEnv()
  let standard: ViteHubStandardProps
  try {
    standard = getStandardContext(event)
  }
  catch (error) {
    if ((error as { name?: unknown })?.name !== "RUNTIME_R0015") throw error
    return getActiveCloudflareEnv()
  }
  return standard.runtime?.cloudflare?.env ?? getActiveCloudflareEnv()
}

/** The host variables of a request. In app tests, the values of `setEnv()` from `vite-hub/test` win over every other source. */
export function runtimeEnv(event?: Request | ViteHubContext): RuntimeEnv {
  return { ...processEnv(), ...cloudflareEnv(event), ...getViteHubTestMode()?.env }
}
