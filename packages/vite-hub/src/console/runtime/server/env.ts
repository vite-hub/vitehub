import { installConsoleEnvScope, resolveConsoleEnv } from "../../internal.ts"
import type { ServerEnvDescription } from "@vite-hub/env"

export function installConsoleEnv(projectRoot: string, description: ServerEnvDescription): ServerEnvDescription {
  return installConsoleEnvScope(projectRoot, description)
}

export function getConsoleEnv(): ServerEnvDescription {
  return resolveConsoleEnv() ?? { entries: [] }
}
