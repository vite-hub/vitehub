import { getViteHubErrorShape } from "@vite-hub/runtime"

import { isRuntimeRecord } from "./runtime-type.ts"

/** One Server Env value that a built-in Channel or gateway reads when its options omit the value. */
export interface BuiltInEnvField {
  /** Host variable names in lookup order. */
  names: readonly [string, ...string[]]
  secret?: true
  /**
   * The value is required when an Agent uses the factory without one of these option keys.
   * Omit it to keep the value optional.
   */
  requiredUnless?: readonly string[]
}

/** The host context that selects Cloudflare bindings when they exist. */
export interface BuiltInEnvContext {
  cloudflare?: { env?: Record<string, unknown> }
  abortSignal?: AbortSignal
}

const serverEnvModuleId = "#vitehub/env/server"

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return isRuntimeRecord(value) && !Array.isArray(value)
}

interface ServerEnvModule {
  loadServerEnv?: (event?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  useServerEnv?: (event?: unknown) => unknown
}

let serverEnvModule: Promise<ServerEnvModule | undefined> | undefined
const loadedServerEnv = new WeakMap<object, Promise<Record<PropertyKey, unknown> | undefined>>()

// Without hubEnv() the generated module does not resolve. Other import failures, such as a
// provider module that throws while it loads, are configuration errors and stay visible.
function isMissingModule(error: unknown): boolean {
  const code = isRecord(error) ? error.code : undefined
  const message = error instanceof Error ? error.message : ""
  if (code === "ERR_MODULE_NOT_FOUND") return /^Cannot find (?:package|module) ['"]#vitehub\/env\/server['"]/.test(message)
  if (code === "ERR_PACKAGE_IMPORT_NOT_DEFINED") return /^Package import specifier ["']#vitehub\/env\/server["'] is not defined/.test(message)
  return /(?:cannot find (?:package|module)|failed to (?:resolve|load)(?: (?:module|url))?|no such module|missing (?:module|package))\s+(?:["']#vitehub\/env\/server["']|#vitehub\/env\/server(?=\s|\(|$))/i.test(message)
}

function importServerEnvModule(): Promise<ServerEnvModule | undefined> {
  // hubEnv() rewrites the tagged import so Vite can resolve its generated module.
  // SAFETY: The generated server env module exposes the optional useServerEnv and loadServerEnv entrypoints.
  serverEnvModule ??= (import(/* @vite-ignore */ /* @vitehub-env */ serverEnvModuleId) as Promise<ServerEnvModule>)
    .catch((error: unknown) => {
      if (isMissingModule(error)) return undefined
      throw error
    })
  return serverEnvModule
}

function envNameParts(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part.toUpperCase())
}

/**
 * The canonical variable name of `env.server.<group>.<field>`, with the same rule as Server Env:
 * `VITEHUB_` and the path in upper snake case. `cloudflareAccess.clientId` becomes `VITEHUB_CLOUDFLARE_ACCESS_CLIENT_ID`.
 */
export function canonicalBuiltInEnvName(group: string, field: string): string {
  return ["VITEHUB", ...envNameParts(group), ...envNameParts(field)].join("_")
}

function envGroup(env: unknown, group: string): Record<PropertyKey, unknown> | undefined {
  const value = isRecord(env) ? env[group] : undefined
  return isRecord(value) ? value : undefined
}

/**
 * Read fields of `env.server.<group>`. A field that Server Env declares is read only from Server Env,
 * including provider-backed values. A field that it does not declare, for example without hubEnv(),
 * is read from its canonical `VITEHUB_` name, then its host variable names. An empty host variable counts as unset.
 */
export async function readBuiltInEnv(
  group: string,
  specs: Readonly<Record<string, BuiltInEnvField>>,
  fields: readonly string[],
  context: BuiltInEnvContext,
): Promise<Partial<Record<string, unknown>>> {
  const cloudflareEnv = context.cloudflare?.env
  const event = cloudflareEnv ? { env: cloudflareEnv } : undefined
  const module = await importServerEnvModule()
  // Resolution errors, such as a missing required value, are configuration errors and stay visible.
  const declared = module?.useServerEnv ? envGroup(module.useServerEnv(event), group) : undefined
  let loaded: Promise<Record<PropertyKey, unknown> | undefined> | undefined
  const values: Partial<Record<string, unknown>> = {}
  for (const field of fields) {
    if (declared && Object.hasOwn(declared, field)) {
      try {
        values[field] = declared[field]
      }
      catch (error) {
        // Provider-backed values need the asynchronous snapshot.
        if (getViteHubErrorShape(error)?.code !== "ENV_ASYNC_REQUIRED" || !module?.loadServerEnv) throw error
        const loadServerEnv = module.loadServerEnv
        loaded ??= loadedServerEnv.get(context)?.then(env => envGroup(env, group))
        if (!loaded) {
          const snapshot = loadServerEnv(event, { signal: context.abortSignal })
          loadedServerEnv.set(context, snapshot.then(env => isRecord(env) ? env : undefined))
          loaded = snapshot.then(env => envGroup(env, group))
        }
        values[field] = (await loaded)?.[field]
      }
      continue
    }
    // The canonical name comes first. An empty host variable counts as unset, so the next name can supply the value.
    const names = specs[field] ? [...new Set([canonicalBuiltInEnvName(group, field), ...specs[field].names])] : []
    values[field] = names
      .map(name => cloudflareEnv?.[name] ?? globalThis.process?.env?.[name])
      .find(value => value !== undefined && value !== "")
  }
  return values
}
