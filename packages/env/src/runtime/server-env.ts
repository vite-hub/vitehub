// The package resolves `#vitehub/env/server` to this module when the Env Vite plugin does not generate it, such as in
// Node outside Vite. Its declarations type the generated module through the `ServerEnv` interface.
import { envErrorDiagnostics } from "../error-diagnostics.ts"

import type { EnvAccessContext } from "../bridge.ts"
import type { ReadonlyServerEnv, ServerEnv, ServerEnvDescription, ServerEnvInspection } from "../types.ts"
import type { ViteHubContext } from "@vite-hub/runtime"

interface ServerEnvLoadOptions {
  access?: EnvAccessContext
  signal?: AbortSignal
}

function notGenerated(accessor: string): never {
  throw envErrorDiagnostics.ENV_NOT_GENERATED({ accessor })
}

/** Reads the declared Server Env. A missing required value throws `ENV_REQUIRED_MISSING`. */
export function useServerEnv(_event?: ViteHubContext): ServerEnv {
  return notGenerated("useServerEnv")
}

/** Loads one immutable Server Env snapshot, including provider-backed values. */
export async function loadServerEnv(_event?: ViteHubContext, _options?: ServerEnvLoadOptions): Promise<ReadonlyServerEnv> {
  return notGenerated("loadServerEnv")
}

/** Runs `callback` with a loaded Server Env snapshot. */
export async function runWithServerEnv<T>(_event: ViteHubContext | undefined, _callback: (env: ReadonlyServerEnv) => T | Promise<T>, _options?: ServerEnvLoadOptions): Promise<T> {
  return notGenerated("runWithServerEnv")
}

/** Inspects the status of each Server Env value without returning values. */
export async function inspectServerEnv(_event?: ViteHubContext, _options?: ServerEnvLoadOptions): Promise<ServerEnvInspection> {
  return notGenerated("inspectServerEnv")
}

/** Lists the Server Env declarations without reading host values or calling providers. */
export function describeServerEnv(): ServerEnvDescription {
  return notGenerated("describeServerEnv")
}

/** Derives a purpose-specific secret from `VITEHUB_SECRET`. */
export async function deriveSecret(_purpose: string, _event?: ViteHubContext): Promise<string> {
  return notGenerated("deriveSecret")
}

/** Answers the Env bridge requests of the Console. */
export async function manageServerEnv(_request: Request): Promise<Response> {
  return notGenerated("manageServerEnv")
}
