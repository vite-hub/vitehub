import { inspectServerEnv } from "#vitehub/env/server"

import { detectHost } from "@vite-hub/runtime"

import { isBlockingServerEnvEntry, runWithCloudflareEnv } from "../server.ts"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { ViteHubHost } from "@vite-hub/runtime"
import type { ServerEnvInspectionEntry, ServerEnvInspectionStatus } from "../types.ts"

/** One Server Env declaration as the running app sees it. It never holds a value, a preview, or a length. */
export interface EnvInspectEntry {
  /** The declaration path, such as `env.server.stripe.key`. */
  path?: string
  /** The host variable names that the declaration reads, in read order. */
  names?: readonly string[]
  /** The host variable name that supplied the value. */
  name?: string
  /** Where the value comes from: a host variable, a literal, or a provider. */
  source: ServerEnvInspectionEntry["source"]
  /** The provider alias of a provider-backed declaration. */
  provider?: string
  required: boolean
  secret: boolean
  status: ServerEnvInspectionStatus
  /** The entry makes `loadServerEnv()` fail. */
  blocking: boolean
  /** The canonical name and a conventional name hold different values. The canonical name wins. */
  conflict?: true
}

export interface EnvInspectResult {
  entries: EnvInspectEntry[]
  /** No entry is blocking. */
  ok: boolean
  /** The host that the app runs on, such as `cloudflare`, so a fix can name `vitehub env push --host <host>`. */
  host?: ViteHubHost
}

function entryOf(entry: ServerEnvInspectionEntry): EnvInspectEntry {
  return {
    ...(entry.path === undefined ? {} : { path: entry.path }),
    ...(entry.names === undefined ? {} : { names: [...entry.names] }),
    ...(entry.name === undefined ? {} : { name: entry.name }),
    source: entry.source,
    ...(entry.provider === undefined ? {} : { provider: entry.provider }),
    required: entry.required,
    secret: entry.masked,
    status: entry.status,
    blocking: isBlockingServerEnvEntry(entry),
    ...(entry.conflict ? { conflict: true as const } : {}),
  }
}

/** Runs `env.inspect`: the Server Env status of the app, with the Worker bindings of the call on Cloudflare. */
export async function inspectEnvOperation(context: Pick<OperationContext, "env">): Promise<EnvInspectResult> {
  const inspection = await (context.env ? runWithCloudflareEnv(context.env, () => inspectServerEnv()) : inspectServerEnv())
  const entries = inspection.entries.map(entryOf)
  const host = detectHost()
  return { entries, ok: !entries.some(entry => entry.blocking), ...(host ? { host } : {}) }
}
