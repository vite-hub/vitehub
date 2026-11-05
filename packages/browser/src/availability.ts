import { ViteHubError } from "@vite-hub/runtime"
import availability from "#vitehub/browser/availability"

/** Returns `true` when this build enables Browser, so Browser Definitions and actions can run. */
export function isBrowserAvailable(): boolean {
  return availability.available
}

export function browserUnavailableError(): ViteHubError<"BROWSER_UNAVAILABLE"> {
  const { preset, reason, fix } = availability.available
    ? { preset: undefined, reason: "The Browser runtime has no provider.", fix: "Set `browser: true` in vitehub() with the Cloudflare preset." }
    : availability
  return new ViteHubError(
    "BROWSER_UNAVAILABLE",
    `[vitehub:browser] Browser is not available${preset ? ` on the ${preset} preset` : ""}. ${reason} ${fix}`,
    { details: { ...(preset ? { preset } : {}), reason, fix } },
  )
}
