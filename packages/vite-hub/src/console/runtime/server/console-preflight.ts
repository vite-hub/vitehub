import { answerConsolePreflight } from "./cors.ts"

import type { ConsoleRequestEvent } from "./request.ts"

/** The part of a Nitro 3 app that the plugin uses: the H3 2 app. Nitro composes `~middleware` again after the plugins run. */
interface ConsolePreflightNitroApp {
  h3?: { "~middleware"?: unknown[] }
}

/**
 * Answer CORS preflights to Console data routes before every app middleware, also the files in `server/middleware/`
 * that Nitro runs before configured handlers. Those middleware and app Auth would reject a preflight, because a
 * preflight carries no credentials.
 */
export default function consolePreflightPlugin(nitroApp: ConsolePreflightNitroApp): void {
  nitroApp.h3?.["~middleware"]?.unshift((event: ConsoleRequestEvent, next: () => unknown) => answerConsolePreflight(event) ?? next())
}
