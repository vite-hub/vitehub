import { join } from "node:path"

export const consoleDevframeRoute = "/_vitehub/rpc/**"

interface ConsoleNitroHandler {
  handler: string
  route: string
}

interface ConsoleNitroHandlers {
  handlers?: ConsoleNitroHandler[]
}

const legacyConsoleHandlerFiles = new Set([
  "agents.get.js",
  "blob.get.js",
  "database.get.js",
  "definitions.get.js",
  "invocation-capabilities.get.js",
  "invocation.get.js",
  "invocations.get.js",
  "kv.get.js",
  "search.get.js",
  "sections.get.js",
  "usage.get.js",
])
const legacyConsoleRoutes = new Set([
  "/api/_vitehub/console/agents",
  "/api/_vitehub/console/blob",
  "/api/_vitehub/console/database",
  "/api/_vitehub/console/definitions",
  "/api/_vitehub/console/invocation-capabilities",
  "/api/_vitehub/console/invocations",
  "/api/_vitehub/console/invocations/:id",
  "/api/_vitehub/console/kv",
  "/api/_vitehub/console/search",
  "/api/_vitehub/console/sections",
  "/api/_vitehub/console/usage",
])

export function reconcileConsoleDevframeHandler(
  nitro: ConsoleNitroHandlers,
  consoleRuntimeRoot: string,
): void {
  const handler = join(consoleRuntimeRoot, "server/devframe.js")
  const packagedLegacyHandlers = new Set(
    [...legacyConsoleHandlerFiles].map((file) => join(consoleRuntimeRoot, "server", file)),
  )
  const handlers = (nitro.handlers ?? []).filter(
    (candidate) => !packagedLegacyHandlers.has(candidate.handler),
  )
  const legacy = handlers.find((candidate) => legacyConsoleRoutes.has(candidate.route))
  if (legacy) {
    throw new TypeError(
      `[vitehub] Cannot install the Console Devframe while the legacy ${legacy.route} handler is configured from ${legacy.handler}. Remove the legacy Console handler.`,
    )
  }
  const conflict = handlers.find(
    (candidate) => candidate.route === consoleDevframeRoute && candidate.handler !== handler,
  )
  if (conflict) {
    throw new TypeError(
      `[vitehub] Cannot install the Console Devframe because ${consoleDevframeRoute} is already configured from ${conflict.handler}.`,
    )
  }
  if (
    !handlers.some(
      (candidate) => candidate.handler === handler && candidate.route === consoleDevframeRoute,
    )
  ) {
    handlers.push({ handler, route: consoleDevframeRoute })
  }
  nitro.handlers = handlers
}
