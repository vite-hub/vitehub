import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { getConsoleSections } from "./sections.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
import { getConsoleEnv, getConsoleEnvStatus } from "./env.ts"
import type { ConsoleEnvResponse } from "./env.ts"
import type { ConsoleRequestEvent } from "./request.ts"

function consoleEnvError(statusCode: number, statusMessage: string) {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_C0001({ message: statusMessage }), { statusCode, statusMessage })
}

/** Returns declaration metadata. `?status=1` adds status from `inspectServerEnv()`, which may call providers. */
export default async function consoleEnvHandler(event: ConsoleRequestEvent): Promise<ConsoleEnvResponse> {
  assertConsoleRequest(event)
  if (!getConsoleSections().includes("env")) throw consoleEnvError(404, "Env section not found.")
  if (consoleRequestURL(event).searchParams.get("status") !== "1") return getConsoleEnv()
  let result: ConsoleEnvResponse | undefined
  try {
    result = await getConsoleEnvStatus(event)
  }
  catch {
    // Keep runtime and provider failure text out of the response.
    throw consoleEnvError(503, "Env status is unavailable.")
  }
  if (!result) throw consoleEnvError(503, "Env status is unavailable.")
  return result
}
