import type { ServerEnvDescription } from "@vite-hub/env"
import { assertConsoleRequest } from "./request.ts"
import { getConsoleSections } from "./sections.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
import { getConsoleEnv } from "./env.ts"
import type { ConsoleRequestEvent } from "./request.ts"

export default function consoleEnvHandler(event: ConsoleRequestEvent): ServerEnvDescription {
  assertConsoleRequest(event)
  if (!getConsoleSections().includes("env")) throw Object.assign(viteHubErrorDiagnostics.VITE_HUB_C0001({ message: "Env section not found." }), { statusCode: 404, statusMessage: "Env section not found." })
  return getConsoleEnv()
}
