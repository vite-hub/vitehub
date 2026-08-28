import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { isViteHubError } from "@vite-hub/runtime"

import {
  asyncServerEnvRequired,
  envSourceFailed,
  invalidRuntimeEnvValue,
  missingRequiredEnv,
} from "./core/errors.ts"
import { SecretEnv } from "./secret.ts"

import type {
  EnvProvider,
  EnvProviders,
  EnvRuntimeRegistry,
  DeepReadonly,
  LoadServerEnvOptions,
  ServerEnvInspection,
  ServerEnvInspectionEntry,
} from "./types.ts"

export type { ServerEnvInspection, ServerEnvInspectionEntry, ServerEnvInspectionStatus } from "./types.ts"

type RuntimeEnv = Record<string, unknown>

interface RuntimeEnvEntry {
  default?: unknown
  required: boolean
  secret: boolean
  source: { kind: "env", label: string, name: string, names?: string[] }
}

interface RuntimeProviderEntry {
  default?: unknown
  required: boolean
  secret: boolean
  source: { key: string, kind: "provider", label: "provider", provider: string }
}

interface RuntimeLiteralEntry {
  kind: "literal"
  value: unknown
}

type ProviderValues = ReadonlyMap<string, unknown>
type ProviderLoads = Map<string, Promise<ProviderValues>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRuntimeLiteralEntry(value: unknown): value is RuntimeLiteralEntry {
  return isRecord(value) && value.kind === "literal"
}

function isRuntimeEnvEntry(value: unknown): value is RuntimeEnvEntry {
  return isRecord(value)
    && isRecord(value.source)
    && value.source.kind === "env"
    && typeof value.source.name === "string"
    && typeof value.required === "boolean"
    && typeof value.secret === "boolean"
}

function isRuntimeProviderEntry(value: unknown): value is RuntimeProviderEntry {
  return isRecord(value)
    && isRecord(value.source)
    && value.source.kind === "provider"
    && typeof value.source.key === "string"
    && typeof value.source.provider === "string"
    && typeof value.required === "boolean"
    && typeof value.secret === "boolean"
}

function processEnv(): RuntimeEnv {
  return typeof process === "object" && process && process.env ? process.env : {}
}

function runtimeEnv(event?: unknown): RuntimeEnv {
  return { ...processEnv(), ...getCloudflareEnv(event) }
}

function readRuntimeSource(entry: RuntimeEnvEntry, env: RuntimeEnv): { found: boolean, value?: unknown } {
  for (const name of entry.source.names || [entry.source.name]) {
    if (Object.hasOwn(env, name) && typeof env[name] !== "undefined") {
      return { found: true, value: env[name] }
    }
  }
  return { found: false }
}

function resolvedRuntimeValue(entry: RuntimeEnvEntry | RuntimeProviderEntry, value: unknown, found: boolean): unknown {
  const resolved = found ? value : entry.default
  if (typeof resolved === "undefined") {
    if (entry.required) {
      throw missingRequiredEnv(entry.source.kind, `Missing Runtime Env from ${entry.source.kind}.`)
    }
    return undefined
  }
  if (typeof resolved !== "string") {
    throw invalidRuntimeEnvValue(entry.source.kind, `Runtime Env from ${entry.source.kind} must resolve to a string.`)
  }
  return entry.secret ? new SecretEnv(resolved) : resolved
}

function resolveRegistryValue(value: unknown, env: RuntimeEnv, path: string): unknown {
  if (isRuntimeLiteralEntry(value)) return value.value
  if (isRuntimeEnvEntry(value)) {
    const source = readRuntimeSource(value, env)
    return resolvedRuntimeValue(value, source.value, source.found)
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
    throw new TypeError("The configured Server Env provider is unavailable or invalid.")
  }
  return provider
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? Object.assign(new Error("Server Env loading was aborted."), { name: "AbortError" })
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

function collectProviderKeys(value: unknown, requests = new Map<string, Set<string>>()): Map<string, Set<string>> {
  if (isRuntimeProviderEntry(value)) {
    let keys = requests.get(value.source.provider)
    if (!keys) {
      keys = new Set()
      requests.set(value.source.provider, keys)
    }
    keys.add(value.source.key)
    return requests
  }
  if (isRuntimeEnvEntry(value) || isRuntimeLiteralEntry(value) || !isRecord(value)) return requests
  for (const child of Object.values(value)) collectProviderKeys(child, requests)
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
      .then(provider => readProvider(provider, { env: localEnv, keys, signal: options.signal }, options.signal))
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
  if (!load) throw envSourceFailed("provider", new TypeError("The Server Env provider was not loaded."))
  return (await load).get(entry.source.key)
}

const skipProviderValue = Symbol("vitehub.env.skip-provider")

function localRegistryValue(value: unknown, env: RuntimeEnv, tolerateInvalid: boolean): unknown {
  if (isRuntimeLiteralEntry(value)) return snapshotValue(value.value)
  if (isRuntimeProviderEntry(value)) return skipProviderValue
  if (isRuntimeEnvEntry(value)) {
    try {
      const source = readRuntimeSource(value, env)
      return resolvedRuntimeValue(value, source.value, source.found)
    }
    catch (error) {
      if (!tolerateInvalid) throw error
      return skipProviderValue
    }
  }
  if (!isRecord(value)) return skipProviderValue
  const output: Record<string, unknown> = Object.create(null)
  for (const [key, child] of Object.entries(value)) {
    const resolved = localRegistryValue(child, env, tolerateInvalid)
    if (resolved !== skipProviderValue) output[key] = resolved
  }
  return Object.freeze(output)
}

function createLocalEnv(
  registry: EnvRuntimeRegistry<never>,
  env: RuntimeEnv,
  tolerateInvalid: boolean,
): Readonly<Record<string, unknown>> {
  return localRegistryValue(registry, env, tolerateInvalid) as Readonly<Record<string, unknown>>
}

async function loadRegistryValue(
  value: unknown,
  env: RuntimeEnv,
  loads: ProviderLoads,
): Promise<unknown> {
  if (isRuntimeLiteralEntry(value)) return snapshotValue(value.value)
  if (isRuntimeEnvEntry(value)) {
    const source = readRuntimeSource(value, env)
    return resolvedRuntimeValue(value, source.value, source.found)
  }
  if (isRuntimeProviderEntry(value)) {
    const resolved = await providerValue(value, loads)
    return resolvedRuntimeValue(value, resolved, typeof resolved !== "undefined")
  }
  if (!isRecord(value)) return undefined

  const output: Record<string, unknown> = Object.create(null)
  for (const [key, child] of Object.entries(value)) {
    output[key] = await loadRegistryValue(child, env, loads)
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
  return typeof value === "string" ? "available" : "invalid"
}

function inspectionPath(path: string): { path?: string } {
  if (path.length > 256) return {}
  return /^(?:env|runtime)(?:\.[A-Za-z_$][A-Za-z0-9_$-]{0,63}){0,8}$/.test(path) ? { path } : {}
}

async function inspectRegistryValue(
  value: unknown,
  env: RuntimeEnv,
  options: LoadServerEnvOptions,
  loads: ProviderLoads,
  path: string,
  entries: ServerEnvInspectionEntry[],
): Promise<void> {
  if (isRuntimeLiteralEntry(value)) {
    entries.push({ masked: false, ...inspectionPath(path), source: "literal", status: "available" })
    return
  }
  if (isRuntimeEnvEntry(value)) {
    const source = readRuntimeSource(value, env)
    entries.push({ masked: value.secret, ...inspectionPath(path), source: "env", status: inspectionStatus(value, source.value, source.found) })
    return
  }
  if (isRuntimeProviderEntry(value)) {
    try {
      const resolved = await providerValue(value, loads)
      entries.push({
        masked: value.secret,
        ...inspectionPath(path),
        source: "provider",
        status: inspectionStatus(value, resolved, typeof resolved !== "undefined"),
      })
    }
    catch (error) {
      if (isCancellation(error, options.signal)) throw error
      entries.push({ masked: value.secret, ...inspectionPath(path), source: "provider", status: "error" })
    }
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    await inspectRegistryValue(child, env, options, loads, `${path}.${key}`, entries)
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
  const value = await loadRegistryValue(registry, env, loads)
  if (options.signal?.aborted) throw abortReason(options.signal)
  return value as DeepReadonly<TServerEnv>
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
  await inspectRegistryValue(registry, env, options, loads, "env.server", entries)
  if (options.signal?.aborted) throw abortReason(options.signal)
  return Object.freeze({ entries: Object.freeze(entries.map(entry => Object.freeze(entry))) })
}
