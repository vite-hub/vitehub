import { answerConsolePreflight } from "./cors.ts"

import type { ConsoleRequestEvent } from "./request.ts"

/** The parts of a Nitro 3 or Nitro 2 app that the plugin uses. */
interface ConsolePreflightNitroApp {
  /** Nitro 3: the H3 2 app. Nitro composes `~middleware` again after the plugins run. */
  h3?: { "~middleware"?: unknown[] }
  /** Nitro 2: the H3 1 app. Its stack is already populated when plugins run. */
  h3App?: { stack?: unknown[] }
}

/**
 * Answer CORS preflights to Console data routes before every app middleware, also the files in `server/middleware/`
 * that Nitro runs before configured handlers. Those middleware and app Auth would reject a preflight, because a
 * preflight carries no credentials.
 */
export default function consolePreflightPlugin(nitroApp: ConsolePreflightNitroApp): void {
  const middleware = nitroApp.h3?.["~middleware"]
  if (Array.isArray(middleware)) {
    middleware.unshift((event: ConsoleRequestEvent, next: () => unknown) => answerConsolePreflight(event) ?? next())
    return
  }
  // H3 1 checks `event.handled` only after invoking a stack layer, even when a request hook responded already.
  // Return the response from the first layer so H3 stops before scanned or configured app middleware.
  nitroApp.h3App?.stack?.unshift({
    handler: (event: ConsoleRequestEvent) => answerConsolePreflight(event),
    route: "/",
  })
}
