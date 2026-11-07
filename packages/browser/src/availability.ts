import { ViteHubError } from "@vite-hub/runtime"
import availability from "#vitehub/browser/availability"

/** Returns `true` when this build enables Browser, so Browser Definitions and actions can run. */
export function isBrowserAvailable(): boolean {
  return availability.available
}

export function browserUnavailableError(): ViteHubError<"BROWSER_UNAVAILABLE"> {
  const { host, reason, fix } = availability.available
    ? { host: undefined, reason: "The Browser runtime has no provider.", fix: "Set `browser: true` in vitehub() with the Cloudflare host." }
    : availability
  return new ViteHubError(
    "BROWSER_UNAVAILABLE",
    `[vitehub:browser] Browser is not available${host ? ` on the ${host} host` : ""}. ${reason} ${fix}`,
    { details: { ...(host ? { host } : {}), reason, fix } },
  )
}
