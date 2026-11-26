import { withConsoleAccess, type ConsoleAccessRoute } from "../../console/runtime/server/access.ts"
import { assertConsoleRequest } from "../../console/runtime/server/request.ts"
import { consoleHttpError } from "../../console/runtime/server/http-error.ts"
import { getConsoleSections } from "../../console/runtime/server/sections.ts"
import { viteHubErrorDiagnostics } from "../../error-diagnostics.ts"
import { getConsoleEnv } from "../../console/runtime/server/env.ts"
import type { ServerEnvDescription } from "@vite-hub/env"
import type { ConsoleRequestEvent } from "../../console/runtime/server/request.ts"

/** Returns declaration metadata. The `env.inspect` operation of Env returns the status of each value. */
async function consoleEnvHandler(event: ConsoleRequestEvent): Promise<ServerEnvDescription> {
  assertConsoleRequest(event)
  if (!getConsoleSections().includes("env")) throw consoleHttpError(404, viteHubErrorDiagnostics.VITE_HUB_C0001({ message: "Env section not found." }))
  return getConsoleEnv()
}

const guardedHandler: ConsoleAccessRoute<typeof consoleEnvHandler> = withConsoleAccess(consoleEnvHandler, { section: "env" })
export default guardedHandler
