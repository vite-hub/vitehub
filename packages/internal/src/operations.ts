import { resolveViteHubProjectRoot } from "./build/vite.ts"
import { findViteHubDevServerUrl } from "./cli.ts"
import { internalErrorDiagnostics } from "./error-diagnostics.ts"
import { standardJsonSchema } from "./standard-schema.ts"
import { withValibotJsonSchema } from "./valibot.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"

/** Path of the operation RPC under the app. Dev servers and deployed apps serve it the same way. */
export const operationRpcPath = "/_vitehub/rpc/__call"
/** Header that proves the caller is not a browser page. A foreign page cannot send it without a CORS preflight. */
export const operationRpcHeader = "x-vitehub-console"
/** Response header of the local dev RPC. Its value is {@link projectRootHash} of the project that the server runs. */
export const operationRootHeader = "x-vitehub-root"
export const operationExpectedRootsHeader = "x-vitehub-expected-roots"
/** A short stable hash of a project root. The CLI uses it to see that the dev server runs its own project. */
export function projectRootHash(root: string): string {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "")
  let first = 0xdeadbeef
  let second = 0x41c6ce57
  for (let index = 0; index < normalized.length; index++) {
    const code = normalized.charCodeAt(index)
    first = Math.imul(first ^ code, 2654435761)
    second = Math.imul(second ^ code, 1597334677)
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909)
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909)
  return `${(second >>> 0).toString(16).padStart(8, "0")}${(first >>> 0).toString(16).padStart(8, "0")}`
}
/** Header that names the tool behind a call. `cli` marks `vitehub` commands. */
export const operationSurfaceHeader = "x-vitehub-surface"

/** `read` never changes state. `write` changes state. `destructive` deletes or publishes. */
export type OperationKind = "read" | "write" | "destructive"

/** The signed-in user of a call. */
export interface OperationUser {
  id: string
  name?: string
  email?: string
  image?: string
  [key: string]: unknown
}

/** The Agent Actor when an agent calls through a capability or MCP on behalf of a user. */
export interface OperationActor {
  id: string
  kind?: string
  label?: string
  meta?: object
}

/** The checked Console access of a call. `vite-hub` issues it. `ConsoleAccess` has this shape. */
export interface OperationAccess {
  readonly mode: string
  /**
   * The sections that the call may use. `"all"` when no section filter applies. An entry is a section id (`"kv"`, every
   * operation of the section) or `"<section>:read"` (only the operations that read).
   */
  readonly sections: "all" | readonly string[]
  readonly user?: OperationUser
}

export interface OperationContext {
  /** The checked Console access of the call. */
  access: OperationAccess
  /** The signed-in user, or null. */
  user: OperationUser | null
  /** The Agent Actor when an agent calls on behalf of `user`. */
  actor?: OperationActor
  surface: "console" | "cli" | "mcp" | "agent"
  /** Set by the host from generated build identity, never from request input or runtime NODE_ENV. */
  development?: boolean
  env?: Record<string, unknown>
  waitUntil?: (task: Promise<unknown>) => void
  request?: Request
  /** Operations set a success status here, such as 202 for an accepted call. */
  response?: { status?: number }
  /**
   * An agent may pass `lease: "override"` to `content.save` only when the developer allowed it. Defaults to false, so a
   * model cannot take over a document that a person is editing.
   */
  overrideLeases?: boolean
}

export interface OperationDefinition<Input, Output> {
  /** `<section>.<verb>`, such as `content.publish`. Unique per app. */
  name: string
  /** One sentence. Becomes the CLI help line and the MCP tool description. */
  description: string
  /**
   * Console section that grants access, such as `content`. `false`: any Console user. A function reads the section
   * from the input, for operations that serve several sections.
   */
  section: string | false | ((input: Input) => string | undefined)
  /** `read` never changes state. `write` changes state. `destructive` deletes or publishes; the CLI asks for `--yes`, MCP marks `destructiveHint`, agents require approval by default. */
  kind: OperationKind
  /** Standard Schema (valibot in this repo). Its Standard JSON Schema builds CLI flags and the MCP input schema. */
  input: StandardSchemaV1<unknown, Input>
  output?: StandardSchemaV1<unknown, Output>
  cli?: {
    /** Defaults: namespace = section, command = verb. */
    namespace?: string
    command?: string
    /** Input keys read from positional arguments, in order. */
    positional?: string[]
    /** Human output. Without it the CLI prints JSON. `--json` always prints JSON. */
    format?: (output: Output) => string
  }
  /** Largest request body in bytes. It can raise the 64 KiB default but not lower it. */
  maxRequestBytes?: number
  /**
   * Returns true when this call only reads, such as a dry run of a `destructive` operation. The CLI then skips the
   * confirmation, and agents run it without approval. Without it, every call of a `destructive` operation asks.
   */
  readOnlyWhen?: (input: Input) => boolean
  /** `false`: the operation never reads `context.user`, so the Console skips the session lookup for it. */
  user?: false
  run: (input: Input, context: OperationContext) => Output | Promise<Output>
}

/** An operation of any input and output, as a registry holds it. */
export interface AnyOperation extends Omit<OperationDefinition<unknown, unknown>, "cli" | "input" | "output" | "readOnlyWhen" | "run" | "section"> {
  readOnlyWhen?: (input: never) => boolean
  cli?: { namespace?: string, command?: string, positional?: string[], format?: (output: never) => string }
  input: StandardSchemaV1
  output?: StandardSchemaV1
  run: (input: never, context: OperationContext) => unknown
  section: string | false | ((input: never) => string | undefined)
}

/** The fields every surface reports for a failed call. */
export interface OperationFailure {
  code: string
  message: string
  fix?: string
  docs?: string
  details?: Record<string, unknown>
  status: number
}

export type OperationResult<Output = unknown> =
  | { ok: true, value: Output }
  | ({ ok: false } & OperationFailure)

const nameFormat = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/
const kinds: ReadonlySet<string> = new Set<OperationKind>(["read", "write", "destructive"])

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function invalidDefinition(name: unknown, reason: string): Error {
  return internalErrorDiagnostics.INTERNAL_R0020({ message: `[vitehub] Operation ${JSON.stringify(name)} is invalid: ${reason}` })
}

function checkDefinition(definition: unknown): void {
  if (!isObject(definition)) throw invalidDefinition(undefined, "defineOperation() takes an object.")
  const { name } = definition
  if (String(name) !== name || !nameFormat.test(name)) throw invalidDefinition(name, "the name must look like `section.verb`, in lower case.")
  if (String(definition.description) !== definition.description || !definition.description) throw invalidDefinition(name, "add a one sentence description.")
  const { section } = definition
  if (section !== false && !(section instanceof Function) && (String(section) !== section || !section)) throw invalidDefinition(name, "section must be a Console section id, a function, or false.")
  if (!kinds.has(String(definition.kind))) throw invalidDefinition(name, 'kind must be "read", "write", or "destructive".')
  const input = definition.input
  if (!isObject(input) || !isObject(input["~standard"]) || !(input["~standard"].validate instanceof Function)) throw invalidDefinition(name, "input must be a Standard Schema, such as a valibot object.")
  if (!(definition.run instanceof Function)) throw invalidDefinition(name, "run must be a function.")
  const { maxRequestBytes } = definition
  if (maxRequestBytes !== undefined && (!Number.isInteger(maxRequestBytes) || Number(maxRequestBytes) < defaultRequestBytes)) {
    throw invalidDefinition(name, `maxRequestBytes can only raise the limit above ${defaultRequestBytes} bytes (64 KiB).`)
  }
  if (definition.readOnlyWhen !== undefined && !(definition.readOnlyWhen instanceof Function)) throw invalidDefinition(name, "readOnlyWhen must be a function.")
}

/** The default limit of a call, in bytes. */
export const defaultRequestBytes: number = 64 * 1_024
/** CLI namespaces owned by built-in commands. */
export const reservedOperationNamespaces: readonly string[] = ["inspect", "provision"]

/** Input keys that the generated CLI commands read themselves. */
export const reservedOperationFlags: readonly string[] = ["input", "json", "timeout", "url", "yes"]

/**
 * Define one operation. The Console, the CLI, MCP, and agent tools call the same definition. Contribute it with
 * `vitehub: { operations: [{ module, export }] }` on a Vite plugin.
 */
export function defineOperation<Input, Output>(definition: OperationDefinition<Input, Output>): OperationDefinition<Input, Output> {
  checkDefinition(definition)
  // Valibot schemas carry no JSON Schema. Add it here, so the CLI and MCP read the fields of any definer's input.
  const defined = { ...definition, input: withValibotJsonSchema(definition.input) }
  const properties = operationInputJsonSchema(defined as unknown as AnyOperation).properties
  const clashes = isObject(properties) ? Object.keys(properties).filter(key => reservedOperationFlags.includes(key)) : []
  if (clashes.length) {
    throw invalidDefinition(definition.name, `the input key ${clashes.map(key => JSON.stringify(key)).join(", ")} is a CLI flag of every command (${reservedOperationFlags.join(", ")}). Rename it.`)
  }
  return defined
}

export function isOperation(value: unknown): value is AnyOperation {
  try {
    checkDefinition(value)
    return true
  }
  catch {
    return false
  }
}

/** The contribution of one plugin: operations, or a module that exports them. */
export interface OperationContributionEntry {
  /** Module the app imports, such as `@vite-hub/content/operations`. */
  module: string
  /** Named export that holds an operation or an array of operations. Defaults to `default`. */
  export?: string
  /** Loads the export in the tool process, for a module that the tool cannot resolve by name. */
  load?: () => Promise<unknown>
  /** `false`: the app already has these operations at runtime. Only tools such as the CLI and `vitehub inspect` read the entry. */
  runtime?: false
}

/** The contribution of a plugin: a list, or a function that returns it, for a plugin that reads the project first. */
export type OperationContributions = readonly OperationContributionEntry[] | (() => readonly OperationContributionEntry[] | Promise<readonly OperationContributionEntry[]>)

export interface OperationContributingPlugin {
  name?: string
  vitehub?: { operations?: OperationContributions }
}

/** A validated contribution with the plugin that added it. */
export interface CollectedOperationContribution {
  module: string
  export: string
  plugin: string
  load?: () => Promise<unknown>
  runtime?: false
}

function pluginName(plugin: object): string {
  const name: unknown = Reflect.get(plugin, "name")
  return String(name) === name && name ? name : "unnamed plugin"
}

/** Reads `plugin.vitehub.operations` from resolved Vite plugins. The same module and export from two plugins counts once. */
export async function collectOperationContributions(plugins: readonly unknown[]): Promise<CollectedOperationContribution[]> {
  const collected = new Map<string, CollectedOperationContribution>()
  for (const plugin of plugins) {
    if (!isObject(plugin) || !Object.hasOwn(plugin, "vitehub")) continue
    const declared: unknown = Reflect.get(Object(Reflect.get(plugin, "vitehub")), "operations")
    if (declared === undefined) continue
    const entries: unknown = declared instanceof Function ? await declared() : declared
    const owner = pluginName(plugin)
    if (!Array.isArray(entries)) throw internalErrorDiagnostics.INTERNAL_B0048({ message: `[vitehub] ${owner} sets vitehub.operations, which must be a list of { module, export }.` })
    for (const entry of entries as unknown[]) {
      if (!isObject(entry) || String(entry.module) !== entry.module || !entry.module) {
        throw internalErrorDiagnostics.INTERNAL_B0048({ message: `[vitehub] ${owner} contributes an operation entry without a module.` })
      }
      const exportName = String(entry.export) === entry.export && entry.export ? entry.export : "default"
      const key = `${entry.module}#${exportName}`
      if (collected.has(key)) continue
      collected.set(key, {
        module: entry.module,
        export: exportName,
        plugin: owner,
        ...(entry.load instanceof Function ? { load: entry.load as () => Promise<unknown> } : {}),
        ...(entry.runtime === false ? { runtime: false as const } : {}),
      })
    }
  }
  return [...collected.values()]
}

/** Operations of one module export, flat. A single operation or an array both work. */
export function operationsOf(value: unknown): AnyOperation[] {
  const list = Array.isArray(value) ? value : [value]
  const operations: AnyOperation[] = []
  for (const item of list as unknown[]) {
    if (!isOperation(item)) {
      throw invalidDefinition(isObject(item) ? item.name : undefined, "a contributed export must hold defineOperation() results.")
    }
    operations.push(item)
  }
  return operations
}

export interface OperationRegistry {
  get(name: string): AnyOperation | undefined
  list(): AnyOperation[]
}

/** The CLI namespace and command of an operation. Defaults: the section (or the name prefix) and the verb. */
export function operationCliPath(operation: Pick<AnyOperation, "cli" | "name" | "section">): { command: string, namespace: string } {
  const dot = operation.name.indexOf(".")
  return {
    command: operation.cli?.command ?? operation.name.slice(dot + 1),
    namespace: operation.cli?.namespace ?? (typeof operation.section === "string" ? operation.section : operation.name.slice(0, dot)),
  }
}

/** Build the registry by name. A duplicate name or CLI command fails with `INTERNAL_B0048` or `INTERNAL_B0049`. */
export function createOperationRegistry(sources: Iterable<{ operations: readonly AnyOperation[], plugin?: string }>): OperationRegistry {
  const byName = new Map<string, { operation: AnyOperation, plugin?: string }>()
  for (const source of sources) {
    for (const operation of source.operations) {
      const existing = byName.get(operation.name)
      if (existing && existing.operation !== operation) {
        const owners = [existing.plugin, source.plugin].filter(Boolean).join(" and ")
        throw internalErrorDiagnostics.INTERNAL_B0048({ message: `[vitehub] Two operations are named ${JSON.stringify(operation.name)}${owners ? ` (${owners})` : ""}.` })
      }
      byName.set(operation.name, { operation, ...(source.plugin ? { plugin: source.plugin } : {}) })
    }
  }
  const operations = [...byName.values()].map(entry => entry.operation).sort((left, right) => left.name.localeCompare(right.name))
  const commands = new Map<string, AnyOperation>()
  for (const operation of operations) {
    const { command, namespace } = operationCliPath(operation)
    if (reservedOperationNamespaces.includes(namespace)) {
      throw invalidDefinition(operation.name, `the CLI namespace ${JSON.stringify(namespace)} is reserved for built-in commands. Set cli.namespace to another name.`)
    }
    const key = `${namespace} ${command}`
    const other = commands.get(key)
    if (other) {
      throw internalErrorDiagnostics.INTERNAL_B0049({ message: `[vitehub] The operations ${JSON.stringify(other.name)} and ${JSON.stringify(operation.name)} are both the CLI command \`vitehub ${key}\`.` })
    }
    commands.set(key, operation)
  }
  return { get: name => byName.get(name)?.operation, list: () => [...operations] }
}

/** Where a registry is installed for code that has no import path to it, such as agent capabilities. */
const registryKey: unique symbol = Symbol.for("vitehub.operations.registry")
const scope = globalThis as typeof globalThis & { [registryKey]?: OperationRegistry }

export function installOperationRegistry(registry: OperationRegistry): void {
  scope[registryKey] = registry
}

export function installedOperationRegistry(): OperationRegistry | undefined {
  return scope[registryKey]
}

/**
 * What `console.authorize` allows for a person. Agents and MCP have no browser request, so the Console installs this
 * resolver, and it calls `authorize` with a request that carries no headers. Without `console.authorize` it returns
 * `"all"`, and the `include` list of the agent is the only gate.
 */
export type OperationSectionResolver = (call: { actor?: OperationActor, user: OperationUser | null }) => Promise<"all" | readonly string[]>

const sectionResolverKey: unique symbol = Symbol.for("vitehub.operations.section-resolver")
const resolverScope = globalThis as typeof globalThis & { [sectionResolverKey]?: OperationSectionResolver }

export function installOperationSectionResolver(resolver: OperationSectionResolver | undefined): void {
  resolverScope[sectionResolverKey] = resolver
}

export function installedOperationSectionResolver(): OperationSectionResolver | undefined {
  return resolverScope[sectionResolverKey]
}

/** JSON Schema of the input, for CLI flags and MCP tool schemas. Falls back to an open object. */
export function operationInputJsonSchema(operation: AnyOperation): Record<string, unknown> {
  return standardJsonSchema(operation.input, "input") ?? { type: "object" }
}

/** Issues of a failed Standard Schema check as one short line per issue. */
export function describeInputIssues(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues.slice(0, 5).map((issue) => {
    const path = (issue.path ?? []).map(segment => String(isObject(segment) && "key" in segment ? segment.key : segment)).join(".")
    return path ? `${path}: ${issue.message}` : issue.message
  }).join(" ")
}

/** Validate `input` with the schema of the operation. Throws `INTERNAL_R0022` with `status: 400`. */
export async function parseOperationInput(operation: AnyOperation, input: unknown): Promise<unknown> {
  const result = await operation.input["~standard"].validate(input ?? {})
  if (!result.issues) return result.value
  const error = internalErrorDiagnostics.INTERNAL_R0022({ message: `Invalid input for ${operation.name}. ${describeInputIssues(result.issues)}` })
  throw Object.assign(error, { status: 400 })
}

/** The section that grants a call, or `false` for any Console user. `undefined` means the input names no valid section. */
export function operationSection(operation: Pick<AnyOperation, "section">, input: unknown): string | false | undefined {
  const section = operation.section
  // SAFETY: Callers pass input that the operation schema accepted.
  return section instanceof Function ? (section as (value: unknown) => string | undefined)(input) : section
}

/** The suffix of a section grant that allows only reads, such as `"kv:read"`. */
export const readOnlySectionSuffix = ":read"

/** What one call does, for the read-only check of a section grant. */
export interface OperationCallKind {
  kind: OperationKind
  /** The call only reads, such as a dry run (`readOnlyWhen`). */
  readOnly?: boolean
}

/**
 * Whether the checked access covers the section. Without `call`, a read-only grant (`"kv:read"`) counts, so the answer
 * is whether the section is visible. With `call`, a read-only grant allows only a `read` operation or a call that only
 * reads. Every surface (RPC, CLI, agents, MCP) checks access here.
 */
export function operationAccessAllows(access: OperationAccess, section: string | false | undefined, call?: OperationCallKind): boolean {
  if (section === false || access.sections === "all") return true
  if (section === undefined) return false
  if (access.sections.includes(section)) return true
  if (!access.sections.includes(`${section}${readOnlySectionSuffix}`)) return false
  return call === undefined || call.kind === "read" || call.readOnly === true
}

/** The kind of one call of an operation: a `readOnlyWhen` match makes a write operation a read. */
export function operationCall(operation: Pick<AnyOperation, "kind" | "readOnlyWhen">, input: unknown): OperationCallKind {
  // SAFETY: Callers pass input that the operation schema accepted.
  return { kind: operation.kind, readOnly: operation.readOnlyWhen?.(input as never) === true }
}

function text(value: unknown): string | undefined {
  return String(value) === value && value ? value : undefined
}

/** Read the shared failure fields from anything an operation throws. */
export function toOperationFailure(error: unknown): OperationFailure {
  const value = Object(error)
  const rawStatus: unknown = Reflect.get(value, "status") ?? Reflect.get(value, "statusCode")
  const status = Number.isInteger(rawStatus) && Number(rawStatus) >= 400 && Number(rawStatus) <= 599 ? Number(rawStatus) : 500
  const message = text(Reflect.get(value, "statusMessage")) ?? (error instanceof Error ? error.message : undefined) ?? "The operation failed."
  const failure: OperationFailure = { code: text(Reflect.get(value, "code")) ?? (status >= 500 ? "OPERATION_FAILED" : "OPERATION_REJECTED"), message, status }
  const fix = text(Reflect.get(value, "fix"))
  const docs = text(Reflect.get(value, "docs"))
  const details: unknown = Reflect.get(value, "details")
  if (fix) failure.fix = fix
  if (docs) failure.docs = docs
  if (isObject(details)) failure.details = details
  return failure
}

export interface RunOperationOptions {
  /** Turns a thrown error into the failure fields. Defaults to {@link toOperationFailure}. */
  failure?: (error: unknown) => OperationFailure
}

/**
 * Run one operation by name: validate the input, check the section against `context.access`, and run. Never throws.
 * The Console RPC and agent tools call it.
 */
export async function runOperation(registry: OperationRegistry, name: string, input: unknown, context: OperationContext, options: RunOperationOptions = {}): Promise<OperationResult> {
  const failure = options.failure ?? toOperationFailure
  try {
    const operation = registry.get(name)
    if (!operation) throw Object.assign(internalErrorDiagnostics.INTERNAL_R0021({ message: `No operation is named ${JSON.stringify(name)}.` }), { status: 404 })
    const parsed = await parseOperationInput(operation, input)
    const section = operationSection(operation, parsed)
    if (!operationAccessAllows(context.access, section)) {
      throw Object.assign(internalErrorDiagnostics.INTERNAL_R0023({ message: `This access does not include the ${JSON.stringify(section)} section, which ${name} needs.` }), { status: 403 })
    }
    if (!operationAccessAllows(context.access, section, operationCall(operation, parsed))) {
      throw Object.assign(internalErrorDiagnostics.INTERNAL_R0023({ message: `This access to the ${JSON.stringify(section)} section is read-only, and ${name} is a ${operation.kind} operation. Grant the section without ":read" to allow it.` }), { status: 403 })
    }
    // SAFETY: The schema of the operation produced `parsed`.
    return { ok: true, value: await (operation.run as (value: unknown, context: OperationContext) => unknown)(parsed, context) }
  }
  catch (error) {
    return { ok: false, ...failure(error) }
  }
}

/** Operation names that other packages call by name, such as the Agent Invocations CLI. */
export const invocationOperationNames = {
  cancel: "invocations.cancel",
  get: "invocations.get",
  list: "invocations.list",
} as const

/** Where a tool sends operation calls. */
export interface OperationTarget {
  /** Origin of the dev server or deployed app. A path prefix is kept, so an app mount works. */
  url: string
  env: Record<string, string | undefined>
  fetch?: typeof fetch
  /** Milliseconds. Defaults to 30 seconds. */
  timeout?: number
  /**
   * Project roots that the caller accepts. The server checks their hashes before dispatch and rejects a mismatch
   * with `INTERNAL_R0025`. The response identity is also checked.
   */
  roots?: readonly string[]
}

export const operationCredentialHint = "Set VITEHUB_CONSOLE_AUTHORIZATION, VITEHUB_CONSOLE_COOKIE, or CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET."

/** Headers of an operation call. The credentials are the ones the Agent Invocations CLI reads. */
export function operationHeaders(env: Record<string, string | undefined>): Headers {
  const headers = new Headers({ "accept": "application/json", "content-type": "application/json", [operationRpcHeader]: "1", [operationSurfaceHeader]: "cli" })
  if (env.VITEHUB_CONSOLE_AUTHORIZATION) headers.set("authorization", env.VITEHUB_CONSOLE_AUTHORIZATION)
  if (env.VITEHUB_CONSOLE_COOKIE) headers.set("cookie", env.VITEHUB_CONSOLE_COOKIE)
  if (env.CF_ACCESS_CLIENT_ID) headers.set("cf-access-client-id", env.CF_ACCESS_CLIENT_ID)
  if (env.CF_ACCESS_CLIENT_SECRET) headers.set("cf-access-client-secret", env.CF_ACCESS_CLIENT_SECRET)
  return headers
}

function unreachable(message: string, status = 503): OperationResult {
  const error = internalErrorDiagnostics.INTERNAL_R0024({ message })
  return { ok: false, code: "INTERNAL_R0024", fix: Reflect.get(error, "fix") as string, message, status }
}

function hasCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(env.VITEHUB_CONSOLE_AUTHORIZATION || env.VITEHUB_CONSOLE_COOKIE || env.CF_ACCESS_CLIENT_ID || env.CF_ACCESS_CLIENT_SECRET)
}

/** Refuse a stale local discovery target before dispatching any operation. */
export function assertOperationProject(request: Request, root: string | undefined): void {
  const expected = request.headers.get(operationExpectedRootsHeader)
  if (expected === null) return
  if (root && expected.split(",").includes(projectRootHash(root))) return
  throw Object.assign(internalErrorDiagnostics.INTERNAL_R0025({ message: "The server runs another project than the command expects." }), { status: 409 })
}

/** Call one operation over the RPC of a dev server or a deployed app. Never throws. */
export async function callOperation(target: OperationTarget, name: string, input: unknown): Promise<OperationResult> {
  const base = new URL(target.url)
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`
  const url = new URL(operationRpcPath.slice(1), base)
  const headers = operationHeaders(target.env)
  if (target.roots?.length) headers.set(operationExpectedRootsHeader, target.roots.map(projectRootHash).join(","))
  let response: Response
  try {
    response = await (target.fetch ?? fetch)(url.href, {
      // The operation comes first so the server can find large calls within the first bytes.
      body: JSON.stringify({ operation: name, input: input ?? {} }),
      headers,
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(target.timeout ?? 30_000),
    })
  }
  catch (error) {
    return unreachable(`The request to ${url.origin} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const served = response.headers.get(operationRootHeader)
  if (served && target.roots?.length && !target.roots.some(root => projectRootHash(root) === served)) {
    const message = `The server at ${url.origin} runs another project than ${target.roots[0]}.`
    const error = internalErrorDiagnostics.INTERNAL_R0025({ message })
    return { ok: false, code: "INTERNAL_R0025", fix: Reflect.get(error, "fix") as string, message, status: 409 }
  }
  const body = await response.text()
  let json: unknown
  try {
    json = body ? JSON.parse(body) : undefined
  }
  catch {
    json = undefined
  }
  if (isObject(json) && json.ok === true) return { ok: true, value: json.value }
  if (isObject(json) && String(json.code) === json.code && String(json.message) === json.message) {
    const failure: OperationResult = { ok: false, code: json.code, message: json.message, status: Number.isInteger(json.status) ? Number(json.status) : response.status }
    if (text(json.fix)) failure.fix = text(json.fix)
    if (text(json.docs)) failure.docs = text(json.docs)
    if (isObject(json.details)) failure.details = json.details
    if ((failure.status === 401 || failure.status === 403) && !hasCredentials(target.env) && !failure.fix) failure.fix = operationCredentialHint
    return failure
  }
  if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
    return unreachable(`${url.origin} asked for authentication (HTTP ${response.status}).`, 401)
  }
  return unreachable(`${url.origin} did not answer as a ViteHub app (HTTP ${response.status}). Pass the origin of an app that runs ViteHub.`, response.status)
}

/** What a command-line tool passes to {@link callOperationFromCli}. */
export interface CliOperationCall {
  /** Environment of the command, with the credentials. */
  env: NodeJS.ProcessEnv
  /** Replaces `fetch`, so tests need no server. */
  fetch?: typeof fetch
  /** The project root of the command. */
  rootDir: string
  /** Request timeout in milliseconds. */
  timeout?: number
  /** `--url`: a deployed app. Without it the command finds the dev server of its project. */
  url?: string
}

/**
 * Call one operation from a `vitehub` command: on `--url` when it is set, else on the dev server that the project
 * started. Never throws. Without a dev server the result is an `INTERNAL_R0024` failure that says to start one.
 */
export async function callOperationFromCli(call: CliOperationCall, name: string, input: unknown): Promise<OperationResult> {
  let roots: string[]
  try {
    roots = [...new Set([call.rootDir, resolveViteHubProjectRoot(call.rootDir)])]
  }
  catch {
    roots = [call.rootDir]
  }
  const url = call.url ?? findViteHubDevServerUrl(roots, call.env)
  if (!url) return unreachable(`No dev server is running for ${call.rootDir}.`)
  return await callOperation({ env: call.env, ...(call.fetch ? { fetch: call.fetch } : {}), roots, ...(call.timeout ? { timeout: call.timeout } : {}), url }, name, input)
}
