import { consoleState } from "../../internal.ts"
import type { ServerEnvDescription } from "@vite-hub/env"

/** Keeps the Server Env declarations for `env.get`. The `env.inspect` operation of Env reads their status. */
export function installConsoleEnv(projectRoot: string, description: ServerEnvDescription): ServerEnvDescription {
  return consoleState().env = { ...description }
}

export function getConsoleEnv(): ServerEnvDescription {
  return { entries: consoleState().env?.entries ?? [] }
}
