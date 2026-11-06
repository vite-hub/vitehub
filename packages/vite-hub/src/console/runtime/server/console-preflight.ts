import { answerConsolePreflight } from "./cors.ts"

import type { ConsoleRequestEvent } from "./request.ts"

/** The parts of a Nitro 3 or Nitro 2 app that the plugin uses. */
interface ConsolePreflightNitroApp {
  /** Nitro 3: the H3 2 app. Nitro composes `~middleware` again after the plugins run. */
  h3?: { "~middleware"?: unknown[] }
  /** Nitro 2: the H3 1 app. Its `request` hook runs before every middleware. */
  h3App?: object
  hooks?: { hook(name: "request", hook: (event: ConsoleRequestEvent & { handled?: boolean, respondWith?: (response: Response) => Promise<void> }) => Promise<void>): void }
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
  if (!nitroApp.h3App || !nitroApp.hooks) return
  nitroApp.hooks.hook("request", async (event) => {
    if (event.handled) return
    const response = answerConsolePreflight(event)
    if (response && event.respondWith) await event.respondWith(response)
  })
}
