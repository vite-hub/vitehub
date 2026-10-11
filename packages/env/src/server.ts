export type { EnvAccessContext } from "./bridge.ts"
import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { isViteHubError } from "@vite-hub/runtime"

import {
  asyncServerEnvRequired,
  envSourceFailed,
  invalidRuntimeEnvValue,
  missingRequiredEnv,
} from "./core/errors.ts"
import { createEnvBridgeHandler } from "./http.ts"
import type { EnvManagement } from "./http.ts"
import { SecretEnv } from "./secret.ts"
import { isRecord, isRuntimeEnvEntry, isRuntimeLiteralEntry, isRuntimeProviderEntry, runtimeRegistryEntries } from "./core/registry.ts"
import type { RuntimeEnvEntry, RuntimeProviderEntry } from "./core/registry.ts"
import { envValueTypeName, parseEnvValue, stringValueSchema } from "./core/values.ts"

import type {
  EnvProvider,
  EnvProviders,
  EnvRuntimeRegistry,
  DeepReadonly,
  LoadServerEnvOptions,
  ServerEnvInspection,
  ServerEnvDescription,
  ServerEnvDescriptionEntry,
  ServerEnvInspectionEntry,
} from "./types.ts"
import { envErrorDiagnostics } from "./error-diagnostics.ts"

export type { ServerEnvInspection, ServerEnvInspectionEntry, ServerEnvInspectionStatus } from "./types.ts"

type RuntimeEnv = Record<string, unknown>

type ProviderValues = ReadonlyMap<string, unknown>
type ProviderLoads = Map<string, Promise<ProviderValues>>

function processEnv(): RuntimeEnv {
  return typeof process === "object" && process && process.env ? process.env : {}
}

function runtimeEnv(event?: unknown): RuntimeEnv {
  return { ...processEnv(), ...getCloudflareEnv(event) }
}

function hasRuntimeName(entry: RuntimeEnvEntry, env: RuntimeEnv, name: string): boolean {
  return Object.hasOwn(env, name) && env[name] !== undefined && !(entry.source.skipEmpty && env[name] === "")
}

function readRuntimeSource(entry: RuntimeEnvEntry, env: RuntimeEnv): { found: boolean, name?: string, value?: unknown } {
  for (const name of entry.source.names || [entry.source.name]) {
    if (hasRuntimeName(entry, env, name)) return { found: true, name, value: env[name] }
  }
  return { found: false }
}

/** Report which kind of name supplied the value, and whether a shadowed conventional name holds another value. */
function runtimeSourceOrigin(entry: RuntimeEnvEntry, env: RuntimeEnv, source: { found: boolean, name?: string, value?: unknown }): Pick<ServerEnvInspectionEntry, "conflict" | "via"> {
  const canonical = entry.source.canonical
  if (!source.found || canonical === undefined || canonical === false) return {}
  if (source.name !== canonical) return { via: "conventional" }
  const conflict = (entry.source.names || [entry.source.name])
    .some(name => name !== canonical && hasRuntimeName(entry, env, name) && env[name] !== source.value)
  return conflict ? { conflict: true, via: "canonical" } : { via: "canonical" }
}

function resolvedRuntimeValue(entry: RuntimeEnvEntry | RuntimeProviderEntry, value: unknown, found: boolean, path: string): unknown {
  const resolved = found ? value : entry.default
  if (typeof resolved === "undefined") {
    if (entry.required) {
      throw missingRequiredEnv(entry.source.kind, `Missing Runtime Env from ${entry.source.kind}.`, path)
    }
    return undefined
  }
  const parsed = parseEnvValue(entry.schema ?? stringValueSchema, resolved)
  if (!parsed.success) {
    // A secret must not list its allowed values, even though the registry rejects secret enums.
    const message = entry.secret ? "The value does not match its declared type." : parsed.message
    throw invalidRuntimeEnvValue(entry.source.kind, `Invalid ${path} from ${entry.source.kind}. ${message}`, path)
  }
  return entry.secret ? new SecretEnv(parsed.data) : parsed.data
}

function resolveRegistryValue(value: unknown, env: RuntimeEnv, path: string): unknown {
  if (isRuntimeLiteralEntry(value)) return value.value
  if (isRuntimeEnvEntry(value)) {
    const source = readRuntimeSource(value, env)
    return resolvedRuntimeValue(value, source.value, source.found, path)
  }
  if (isRuntimeProviderEntry(value)) throw asyncServerEnvRequired(path)
  if (!isRecord(value)) return undefined
  const output: Record<string, unknown> = Object.create(null)
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (isRuntimeProviderEntry(child)) {
      Object.defineProperty(output, key, {
        enumerable: true,
        get() {
          throw asyncServerEnvRequired(childPath)
        },
      })
    }
    else {
      output[key] = resolveRegistryValue(child, env, childPath)
    }
  }
  return output
}

function providerFor(name: string, providers: EnvProviders | undefined): EnvProvider {
  let provider: EnvProvider | undefined
  try {
    const configured = providers && Object.hasOwn(providers, name)
      ? providers[name]
      : undefined
    if (configured && typeof configured === "object" && typeof configured.read === "function") {
      const read = configured.read
      provider = { read: input => read.call(configured, input) }
    }
  }
  catch (cause) {
    throw envSourceFailed("provider", cause)
  }
  if (!provider) {
    throw envErrorDiagnostics.ENV_R0019({ message: "The configured Server Env provider is unavailable or invalid." })
  }
  return provider
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? Object.assign(envErrorDiagnostics.ENV_R0020({ message: "Server Env loading was aborted." }), { name: "AbortError" })
    : signal.reason
}

async function withAbort<T>(operation: () => Promise<T> | T, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await operation()
  if (signal.aborted) throw abortReason(signal)
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal))
    signal.addEventListener("abort", abort, { once: true })
    const pending = Promise.resolve().then(() => {
      if (signal.aborted) throw abortReason(signal)
      return operation()
    })
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted && error === abortReason(signal))
}

async function readProvider(
  provider: EnvProvider,
  input: Parameters<EnvProvider["read"]>[0],
  signal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    return await withAbort(() => provider.read(input), signal)
  }
  catch (cause) {
    if (isCancellation(cause, signal)) throw cause
    throw envSourceFailed("provider", cause)
  }
}

function collectProviderKeys(value: unknown): Map<string, Set<string>> {
  const requests = new Map<string, Set<string>>()
  for (const { entry } of runtimeRegistryEntries(value)) {
    if (!isRuntimeProviderEntry(entry)) continue
    let keys = requests.get(entry.source.provider)
    if (!keys) {
      keys = new Set()
      requests.set(entry.source.provider, keys)
    }
    keys.add(entry.source.key)
  }
  return requests
}

function normalizeProviderValues(value: unknown, keys: readonly string[]): ProviderValues {
  let record: Record<string, unknown> | undefined
  try {
    if (isRecord(value)) record = value
  }
  catch (cause) {
    throw envSourceFailed("provider", cause)
  }
  if (!record) {
    throw invalidRuntimeEnvValue("provider", "A Server Env provider must return a plain record.")
  }
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(record)
  }
  catch (cause) {
    throw envSourceFailed("provider", cause)
  }
  if (prototype !== null && prototype !== Object.prototype) {
    throw invalidRuntimeEnvValue("provider", "A Server Env provider must return a plain record.")
  }
  const output = new Map<string, unknown>()
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(record, key)
    }
    catch (cause) {
      throw envSourceFailed("provider", cause)
    }
    if (!descriptor) {
      output.set(key, undefined)
      continue
    }
    if (!("value" in descriptor)) {
      throw invalidRuntimeEnvValue("provider", "A Server Env provider returned an accessor instead of a value.")
    }
    output.set(key, descriptor.value)
  }
  return output
}

function createProviderLoads(
  registry: EnvRuntimeRegistry<never>,
  localEnv: Readonly<Record<string, unknown>>,
  options: LoadServerEnvOptions,
): ProviderLoads {
  if (options.signal?.aborted) throw abortReason(options.signal)
  const loads: ProviderLoads = new Map()
  for (const [name, requested] of collectProviderKeys(registry)) {
    const keys = Object.freeze([...requested])
    const load = Promise.resolve()
      .then(() => providerFor(name, options.providers))
      .then(provider => readProvider(provider, { env: localEnv, keys, signal: options.signal, ...(options.access ? { access: options.access } : {}) }, options.signal))
      .then(value => normalizeProviderValues(value, keys))
      .catch((cause) => {
        if (options.signal?.aborted) throw abortReason(options.signal)
        if (isCancellation(cause, options.signal) || isViteHubError(cause)) throw cause
        throw envSourceFailed("provider", cause)
      })
    loads.set(name, load)
  }
  return loads
}

async function providerValue(entry: RuntimeProviderEntry, loads: ProviderLoads): Promise<unknown> {
  const load = loads.get(entry.source.provider)
  if (!load) throw envSourceFailed("provider", envErrorDiagnostics.ENV_R0021({ message: "The Server Env provider was not loaded." }))
  return (await load).get(entry.source.key)
}

const skipProviderValue = Symbol("vitehub.env.skip-provider")

function localRegistryValue(value: unknown, env: RuntimeEnv, tolerateInvalid: boolean, path: string): unknown {
  if (isRuntimeLiteralEntry(value)) return snapshotValue(value.value)
  if (isRuntimeProviderEntry(value)) return skipProviderValue
  if (isRuntimeEnvEntry(value)) {
    try {
      const source = readRuntimeSource(value, env)
      return resolvedRuntimeValue(value, source.value, source.found, path)
    }
    catch (error) {
      if (!tolerateInvalid) throw error
      return skipProviderValue
    }
  }
  if (!isRecord(value)) return skipProviderValue
  const output: Record<string, unknown> = Object.create(null)
  for (const [key, child] of Object.entries(value)) {
    const resolved = localRegistryValue(child, env, tolerateInvalid, `${path}.${key}`)
    if (resolved !== skipProviderValue) output[key] = resolved
  }
  return Object.freeze(output)
}

function createLocalEnv(
  registry: EnvRuntimeRegistry<never>,
  env: RuntimeEnv,
  tolerateInvalid: boolean,
): Readonly<Record<string, unknown>> {
  return localRegistryValue(registry, env, tolerateInvalid, "env.server") as Readonly<Record<string, unknown>>
}

async function loadRegistryValue(
  value: unknown,
  env: RuntimeEnv,
  loads: ProviderLoads,
  path: string,
): Promise<unknown> {
  if (isRuntimeLiteralEntry(value)) return snapshotValue(value.value)
  if (isRuntimeEnvEntry(value)) {
    const source = readRuntimeSource(value, env)
    return resolvedRuntimeValue(value, source.value, source.found, path)
  }
  if (isRuntimeProviderEntry(value)) {
    const resolved = await providerValue(value, loads)
    return resolvedRuntimeValue(value, resolved, typeof resolved !== "undefined", path)
  }
  if (!isRecord(value)) return undefined

  const output: Record<string, unknown> = Object.create(null)
  for (const [key, child] of Object.entries(value)) {
    output[key] = await loadRegistryValue(child, env, loads, `${path}.${key}`)
  }
  return Object.freeze(output)
}

function snapshotValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return Object.freeze(value.map(snapshotValue))
}

function inspectionStatus(
  entry: RuntimeEnvEntry | RuntimeProviderEntry,
  value: unknown,
  found: boolean,
): ServerEnvInspectionEntry["status"] {
  if (!found && typeof entry.default !== "undefined") return "defaulted"
  if (!found || typeof value === "undefined") return "missing"
  return parseEnvValue(entry.schema ?? stringValueSchema, value).success ? "available" : "invalid"
}

function inspectionPath(path: string): { path?: string } {
  if (path.length > 256) return {}
  return /^(?:env|runtime)(?:\.[A-Za-z_$][A-Za-z0-9_$-]{0,63}){0,8}$/.test(path) ? { path } : {}
}

function inspectionProvider(entry: RuntimeProviderEntry): { provider?: string } {
  return /^[A-Za-z0-9_-]{1,64}$/.test(entry.source.provider) ? { provider: entry.source.provider } : {}
}

async function inspectRegistryEntry(
  value: unknown,
  env: RuntimeEnv,
  options: LoadServerEnvOptions,
  loads: ProviderLoads,
  path: string,
  entries: ServerEnvInspectionEntry[],
): Promise<void> {
  if (isRuntimeLiteralEntry(value)) {
    entries.push({ masked: false, ...inspectionPath(path), required: false, source: "literal", status: "available" })
    return
  }
  if (isRuntimeEnvEntry(value)) {
    const source = readRuntimeSource(value, env)
    entries.push({ masked: value.secret, ...inspectionPath(path), required: value.required, source: "env", status: inspectionStatus(value, source.value, source.found), ...runtimeSourceOrigin(value, env, source) })
    return
  }
  if (isRuntimeProviderEntry(value)) {
    try {
      const resolved = await providerValue(value, loads)
      entries.push({
        masked: value.secret,
        ...inspectionPath(path),
        ...inspectionProvider(value),
        required: value.required,
        source: "provider",
        status: inspectionStatus(value, resolved, typeof resolved !== "undefined"),
      })
    }
    catch (error) {
      if (isCancellation(error, options.signal)) throw error
      entries.push({ masked: value.secret, ...inspectionPath(path), ...inspectionProvider(value), required: value.required, source: "provider", status: "error" })
    }
    return
  }
}

export function resolveServerEnv<TServerEnv extends Record<string, unknown> = Record<string, unknown>>(
  registry: EnvRuntimeRegistry<TServerEnv>,
  event?: unknown,
): TServerEnv {
  return resolveRegistryValue(registry, runtimeEnv(event), "env.server") as TServerEnv
}

export async function loadServerEnv<TServerEnv extends Record<string, unknown> = Record<string, unknown>>(
  registry: EnvRuntimeRegistry<TServerEnv>,
  event?: unknown,
  options: LoadServerEnvOptions = {},
): Promise<DeepReadonly<TServerEnv>> {
  if (options.signal?.aborted) throw abortReason(options.signal)
  const env = runtimeEnv(event)
  const localEnv = createLocalEnv(registry, env, false)
  const loads = createProviderLoads(registry, localEnv, options)
  await Promise.all(loads.values())
  if (options.signal?.aborted) throw abortReason(options.signal)
  const value = await loadRegistryValue(registry, env, loads, "env.server")
  if (options.signal?.aborted) throw abortReason(options.signal)
  return value as DeepReadonly<TServerEnv>
}

/** Describe declarations without loading host values or calling providers. */
export function describeServerEnv(registry: EnvRuntimeRegistry): ServerEnvDescription {
  const entries: ServerEnvDescriptionEntry[] = []
  for (const { entry: value, path } of runtimeRegistryEntries(registry)) {
    if (isRuntimeLiteralEntry(value)) {
      entries.push({ ...inspectionPath(path), source: "literal", secret: false, required: false, hasDefault: false })
      continue
    }
    if (isRuntimeEnvEntry(value) || isRuntimeProviderEntry(value)) {
      entries.push({
        ...inspectionPath(path),
        ...(isRuntimeEnvEntry(value) && value.source.canonical && /^[A-Z_][A-Z0-9_]{0,127}$/.test(value.source.canonical) ? { canonicalName: value.source.canonical } : {}),
        source: value.source.kind,
        ...(isRuntimeProviderEntry(value) ? inspectionProvider(value) : {}),
        secret: value.secret,
        required: value.required,
        hasDefault: value.default !== undefined,
        type: value.secret && value.schema?.kind === "enum" ? "enum" : envValueTypeName(value.schema ?? stringValueSchema),
      })
    }
  }
  return { entries }
}

/** Returns whether an inspection entry makes `loadServerEnv()` fail: invalid, provider error, or required and missing. */
export function isBlockingServerEnvEntry(entry: ServerEnvInspectionEntry): boolean {
  return entry.status === "invalid" || entry.status === "error" || (entry.required && entry.status === "missing")
}

export async function inspectServerEnv(
  registry: EnvRuntimeRegistry,
  event?: unknown,
  options: LoadServerEnvOptions = {},
): Promise<ServerEnvInspection> {
  if (options.signal?.aborted) throw abortReason(options.signal)
  const env = runtimeEnv(event)
  const localEnv = createLocalEnv(registry, env, true)
  const loads = createProviderLoads(registry, localEnv, options)
  await Promise.allSettled(loads.values())
  if (options.signal?.aborted) throw abortReason(options.signal)
  const entries: ServerEnvInspectionEntry[] = []
  for (const { entry, path } of runtimeRegistryEntries(registry)) {
    await inspectRegistryEntry(entry, env, options, loads, path, entries)
  }
  if (options.signal?.aborted) throw abortReason(options.signal)
  return Object.freeze({ entries: Object.freeze(entries.map(entry => Object.freeze(entry))) })
}

/** Limit management to safe, declared provider paths. Host variables stay read-only. */
export function createServerEnvManagement(registry: EnvRuntimeRegistry, providers: EnvProviders): (request: Request) => Promise<Response> {
  const targets = new Map<string, { key: string; management: EnvManagement }>()
  for (const { entry, path } of runtimeRegistryEntries(registry)) {
    if (!isRuntimeProviderEntry(entry)) continue
    const management = Object.hasOwn(providers, entry.source.provider) ? providers[entry.source.provider]?.management : undefined
    if (inspectionPath(path).path && management) targets.set(path, { key: entry.source.key, management })
  }
  return createEnvBridgeHandler(path => targets.get(path))
}
