export type { EnvAccessContext } from "./bridge.ts"
export type { ViteHubContext } from "@vite-hub/runtime"
import { getActiveCloudflareEnv, runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { deriveViteHubSecret, readViteHubSecret, viteHubSecretMinimumLength } from "@vite-hub/internal/secret"
import { isViteHubError } from "@vite-hub/runtime"
import { getStandardContext } from "@vite-hub/runtime/h3"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import {
  asyncServerEnvRequired,
  envSourceFailed,
  invalidEnvDeclaration,
  invalidRuntimeEnvValue,
  missingRequiredEnv,
} from "./core/errors.ts"
import { SecretEnv } from "./secret.ts"
import { isRecord, isRuntimeEnvEntry, isRuntimeLiteralEntry, isRuntimeProviderEntry, runtimeRegistryEntries } from "./core/registry.ts"
import type { RuntimeEnvEntry, RuntimeProviderEntry } from "./core/registry.ts"
import { envValueTypeName, parseEnvValue, stringValueSchema } from "./core/values.ts"
import type { EnvValueParseResult } from "./core/values.ts"

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
import type { ViteHubContext, ViteHubStandardProps } from "@vite-hub/runtime"

export type { ServerEnvInspection, ServerEnvInspectionEntry, ServerEnvInspectionStatus } from "./types.ts"
// The generated `#vitehub/env/server` module builds its `seal()` and `unseal()` with it.
export { createSealing, seal, unseal } from "./seal-value.ts"
export type { SealOptions, UnsealErrorCode, UnsealOptions, UnsealSchemaOptions } from "./seal-value.ts"

type RuntimeEnv = Record<string, unknown>

type ProviderValues = ReadonlyMap<string, unknown>
type ProviderLoads = Map<string, Promise<ProviderValues>>

function processEnv(): RuntimeEnv {
  return typeof process === "object" && process && process.env ? process.env : {}
}

/**
 * The Cloudflare bindings in the request's Standard Context, else the bindings of the active Cloudflare request.
 * Installs Standard Context on H3 events when needed. A value without an event request, such as Auth's `Request`,
 * reads the active bindings.
 */
function cloudflareEnv(event?: ViteHubContext): RuntimeEnv | undefined {
  if (!event) return getActiveCloudflareEnv()
  let standard: ViteHubStandardProps
  try {
    standard = getStandardContext(event)
  }
  catch (error) {
    if ((error as { name?: unknown })?.name !== "RUNTIME_R0015") throw error
    return getActiveCloudflareEnv()
  }
  return standard.runtime?.cloudflare?.env ?? getActiveCloudflareEnv()
}

/**
 * Run `callback` with `env` as the active Cloudflare bindings. Server Env reads them when a call gets no request
 * event, such as for the module bindings of `cloudflare:workers` outside a request.
 */
export function runWithCloudflareEnv<T>(env: RuntimeEnv, callback: () => T): T {
  return runWithActiveCloudflareEnv(env, callback)
}

/** In app tests, the values of `setEnv()` from `vite-hub/test` win over every other source. */
function runtimeEnv(event?: ViteHubContext): RuntimeEnv {
  return { ...processEnv(), ...cloudflareEnv(event), ...getViteHubTestMode()?.env }
}

let warnedGeneratedSecret = false

/** Options of `deriveSecret()`. */
export interface DeriveSecretOptions {
  /** The request event. On Cloudflare, ViteHub reads `VITEHUB_SECRET` from its Worker bindings. */
  event?: ViteHubContext
  /** The root secret. Without it, ViteHub reads `VITEHUB_SECRET`. */
  root?: string
}

/** The development secret that the Vite plugin generated or selected for one project. Private to the generated module. */
interface DevelopmentSecret {
  envKey?: string
  generated?: boolean
}

/**
 * Derives a 32-byte hex secret for one purpose from the root app secret, `VITEHUB_SECRET`.
 * It uses HKDF-SHA256, so the result is stable while the root is unchanged and distinct for every purpose.
 * Namespace the purpose to its owner, such as `my-module:session`. ViteHub reserves the `vitehub:` prefix.
 * Throws `ENV_REQUIRED_MISSING` when no root secret is set, and `ENV_RUNTIME_VALUE_INVALID` when it is shorter than 32 characters.
 * Only the generated `#vitehub/env/server` module passes `development`, with the project's development secret.
 */
export async function deriveSecret(purpose: string, options: DeriveSecretOptions = {}, development: DevelopmentSecret = {}): Promise<string> {
  const env = runtimeEnv(options.event)
  const root = options.root ?? readViteHubSecret(env) ?? (development.envKey ? env[development.envKey] as string | undefined : undefined)
  if (!root) throw missingRequiredEnv("env", "deriveSecret() requires VITEHUB_SECRET. Generate one with `openssl rand -base64 32`.", "VITEHUB_SECRET")
  if (root.length < viteHubSecretMinimumLength) {
    throw invalidRuntimeEnvValue("env", `VITEHUB_SECRET must be at least ${viteHubSecretMinimumLength} characters. Generate one with \`openssl rand -base64 32\`.`, "VITEHUB_SECRET")
  }
  if ((development.generated || env.VITEHUB_SECRET_GENERATED === "1") && !warnedGeneratedSecret) {
    warnedGeneratedSecret = true
    console.warn("[vitehub] A generated development VITEHUB_SECRET is in use. Set VITEHUB_SECRET for deployments: builds never generate one.")
  }
  return await deriveViteHubSecret(root, purpose)
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

/** Server Env resolves every declaration together, so the message must say why reading another value fails. */
function missingRuntimeValueMessage(entry: RuntimeEnvEntry | RuntimeProviderEntry, path: string): string {
  const supply = entry.source.kind === "env"
    ? `Set ${(entry.source.names || [entry.source.name]).join(" or ")}`
    : "Return it from the provider"
  // A default is serialized into the generated server module, so a secret must not be told to use one.
  const fix = entry.secret ? `${supply} or declare it with optional: true.` : `${supply}, give it a default, or declare it with optional: true.`
  return `${path} is required and has no value. Server Env checks every declared value together, so this fails even when code reads only another value. ${fix}`
}

interface BoundStandardSchema {
  "~standard": { validate: (value: unknown) => unknown }
}

const boundSchemas = new WeakMap<object, BoundStandardSchema>()

/**
 * Attach the schemas that `env.schemaFrom()` declarations name. The generated `#vitehub/env/server` module imports
 * each schema module and calls this once, so a missing or wrong export fails when the server starts.
 */
export function bindServerEnvSchemas(registry: EnvRuntimeRegistry, modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>): void {
  for (const { entry, path } of runtimeRegistryEntries(registry)) {
    if (!(isRuntimeEnvEntry(entry) || isRuntimeProviderEntry(entry)) || !entry.schemaModule) continue
    const reference = entry.schemaModule
    const module = Object.hasOwn(modules, reference.module) ? modules[reference.module] : undefined
    const schema = module && Object.hasOwn(module, reference.export) ? module[reference.export] : undefined
    if (!isBoundStandardSchema(schema)) {
      throw invalidEnvDeclaration(path, `${path} uses env.schemaFrom(${JSON.stringify(reference.module)}, ${JSON.stringify(reference.export)}), but that export is not a Standard Schema.`)
    }
    boundSchemas.set(entry, schema)
  }
}

function isBoundStandardSchema(value: unknown): value is BoundStandardSchema {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false
  const standard = (value as { "~standard"?: unknown })["~standard"]
  return typeof standard === "object" && standard !== null && typeof (standard as { validate?: unknown }).validate === "function"
}

function parseRuntimeValue(entry: RuntimeEnvEntry | RuntimeProviderEntry, value: unknown, path: string): EnvValueParseResult {
  if (!entry.schemaModule) return parseEnvValue(entry.schema ?? stringValueSchema, value)
  const schema = boundSchemas.get(entry)
  if (!schema) {
    throw invalidEnvDeclaration(path, `${path} uses env.schemaFrom(), but no schema module was loaded for it. Only env.server declarations of hubEnv() support env.schemaFrom().`)
  }
  let result: unknown
  try {
    result = schema["~standard"].validate(value)
  }
  catch (error) {
    return { message: `The schema threw: ${error instanceof Error ? error.message : String(error)}`, success: false }
  }
  if (isPromiseLike(result)) {
    Promise.resolve(result).catch(() => undefined)
    return { message: "The schema is async. Server Env runs schemas synchronously.", success: false }
  }
  const issues = isRecord(result) ? result.issues : undefined
  if (Array.isArray(issues) && issues.length) return { message: formatSchemaIssues(issues), success: false }
  if (!isRecord(result) || !("value" in result)) return { message: "The schema returned no value.", success: false }
  return { data: result.value, success: true }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function"
}

function formatSchemaIssues(issues: readonly unknown[]): string {
  return issues.map((issue) => {
    const message = isRecord(issue) && typeof issue.message === "string" ? issue.message : "Invalid value."
    const segments = isRecord(issue) && Array.isArray(issue.path)
      ? issue.path.map(segment => isRecord(segment) ? segment.key : segment).filter(segment => typeof segment === "string" || typeof segment === "number")
      : []
    return segments.length ? `${segments.join(".")}: ${message}` : message
  }).join("; ")
}

function resolvedRuntimeValue(entry: RuntimeEnvEntry | RuntimeProviderEntry, value: unknown, found: boolean, path: string, snapshot = false): unknown {
  const resolved = found ? value : entry.default
  if (typeof resolved === "undefined") {
    if (entry.required) {
      throw missingRequiredEnv(entry.source.kind, missingRuntimeValueMessage(entry, path), path)
    }
    return undefined
  }
  const parsed = parseRuntimeValue(entry, resolved, path)
  if (!parsed.success) {
    // A secret must not list its allowed values, even though the registry rejects secret enums.
    // Schema issue messages can quote the input, so a secret hides them too.
    const message = entry.secret
      ? entry.schemaModule ? "The value does not match its schema." : "The value does not match its declared type."
      : parsed.message
    throw invalidRuntimeEnvValue(entry.source.kind, `Invalid ${path} from ${entry.source.kind}. ${message}`, path)
  }
  const data = snapshot ? snapshotValue(parsed.data) : parsed.data
  return entry.secret ? new SecretEnv(data) : data
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

/**
 * Copy the namespace records of a resolved registry, so a caller that changes its result does not change the cached
 * one. resolveRegistryValue() creates each namespace without a prototype, and provider getters keep their descriptor.
 */
function copyNamespaces(value: object): object {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const descriptor of Object.values(descriptors)) {
    if (isNamespace(descriptor.value)) descriptor.value = copyNamespaces(descriptor.value)
  }
  return Object.create(null, descriptors)
}

function isNamespace(value: unknown): value is object {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === null
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
      return resolvedRuntimeValue(value, source.value, source.found, path, true)
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
    return resolvedRuntimeValue(value, source.value, source.found, path, true)
  }
  if (isRuntimeProviderEntry(value)) {
    const resolved = await providerValue(value, loads)
    return resolvedRuntimeValue(value, resolved, typeof resolved !== "undefined", path, true)
  }
  if (!isRecord(value)) return undefined

  const output: Record<string, unknown> = Object.create(null)
  for (const [key, child] of Object.entries(value)) {
    output[key] = await loadRegistryValue(child, env, loads, `${path}.${key}`)
  }
  return Object.freeze(output)
}

function snapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotValue))
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotValue(item)])))
  }
  return value
}

function inspectionStatus(
  entry: RuntimeEnvEntry | RuntimeProviderEntry,
  value: unknown,
  found: boolean,
  path: string,
): ServerEnvInspectionEntry["status"] {
  if (!found && typeof entry.default !== "undefined") {
    return !entry.schemaModule || parseRuntimeValue(entry, entry.default, path).success ? "defaulted" : "invalid"
  }
  if (!found || typeof value === "undefined") return "missing"
  return parseRuntimeValue(entry, value, path).success ? "available" : "invalid"
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
    entries.push({ masked: value.secret, ...inspectionPath(path), required: value.required, source: "env", status: inspectionStatus(value, source.value, source.found, path), ...runtimeSourceOrigin(value, env, source) })
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
        status: inspectionStatus(value, resolved, typeof resolved !== "undefined", path),
      })
    }
    catch (error) {
      if (isCancellation(error, options.signal)) throw error
      entries.push({ masked: value.secret, ...inspectionPath(path), ...inspectionProvider(value), required: value.required, source: "provider", status: "error" })
    }
    return
  }
}

const registryEnvNames = new WeakMap<object, readonly string[] | null>()
const resolvedServerEnvs = new WeakMap<object, { key: string, value: unknown }>()

/** The env names a registry reads, or null when it declares an array or object, since each call returns its own copy. */
function reusableEnvNames(registry: object): readonly string[] | null {
  const known = registryEnvNames.get(registry)
  if (known !== undefined) return known
  let names: string[] | null = []
  for (const { entry } of runtimeRegistryEntries(registry)) {
    if (!isRuntimeEnvEntry(entry)) continue
    // A schema from env.schemaFrom() can return an object, and a call must not share it.
    if (entry.schemaModule || entry.schema?.kind === "array" || entry.schema?.kind === "object") {
      names = null
      break
    }
    names.push(...entry.source.names || [entry.source.name])
  }
  registryEnvNames.set(registry, names)
  return names
}

/** The values of every name the registry reads, as one string. Undefined when the result must not be reused. */
function serverEnvKey(registry: object, event: ViteHubContext | undefined): string | undefined {
  const names = reusableEnvNames(registry)
  // Test values change between tests, so a test reads the env again on each call.
  if (!names || getViteHubTestMode()) return undefined
  const host = processEnv()
  const cloudflare = cloudflareEnv(event) ?? {}
  let key = ""
  for (const name of names) {
    const value = Object.hasOwn(cloudflare, name) ? cloudflare[name] : Object.hasOwn(host, name) ? host[name] : undefined
    if (value === undefined) key += `${name}\0`
    else if (typeof value === "string") key += `${name}=s${value.length}:${value}\0`
    else if (typeof value === "number" || typeof value === "boolean") key += `${name}=${typeof value === "number" ? "n" : "b"}${String(value)}\0`
    else return undefined
  }
  return key
}

/**
 * Apps call `useServerEnv()` on hot paths, often once per listed row. The result is reused while every name the
 * registry reads holds the same value, so a call does not copy the whole env and parse each declaration again. Each
 * call still gets its own records.
 */
export function resolveServerEnv<TServerEnv extends Record<string, unknown> = Record<string, unknown>>(
  registry: EnvRuntimeRegistry<TServerEnv>,
  event?: ViteHubContext,
): TServerEnv {
  const key = serverEnvKey(registry, event)
  if (key === undefined) return resolveRegistryValue(registry, runtimeEnv(event), "env.server") as TServerEnv
  let cached = resolvedServerEnvs.get(registry)
  if (cached?.key !== key) {
    cached = { key, value: resolveRegistryValue(registry, runtimeEnv(event), "env.server") }
    resolvedServerEnvs.set(registry, cached)
  }
  return (isNamespace(cached.value) ? copyNamespaces(cached.value) : cached.value) as TServerEnv
}

export async function loadServerEnv<TServerEnv extends Record<string, unknown> = Record<string, unknown>>(
  registry: EnvRuntimeRegistry<TServerEnv>,
  event?: ViteHubContext,
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
        type: value.schemaModule ? "unknown" : value.secret && value.schema?.kind === "enum" ? "enum" : envValueTypeName(value.schema ?? stringValueSchema),
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
  event?: ViteHubContext,
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
