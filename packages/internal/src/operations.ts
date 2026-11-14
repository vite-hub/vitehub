import { resolveViteHubProjectRoot } from "./build/vite.ts"
import { findViteHubDevServerUrl } from "./cli.ts"
import { internalErrorDiagnostics } from "./error-diagnostics.ts"
import { isRecordOrFunction as isObject } from "./object.ts"
import { callOperationRpc, operationRpcPath, readOperationRpcError } from "./operation-rpc.ts"
import { readConsoleSigningKey, signConsoleRequest } from "./console-signature.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { invalidDefinition, isOperation, isSectionId, reservedOperationNamespaces } from "./operation-definition.ts"
import type { AnyOperation, OperationAccess, OperationActor, OperationContext, OperationFailure, OperationKind, OperationResult, OperationUser } from "./operation-definition.ts"

export * from "./operation-definition.ts"

export { operationRpcPath }
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
/** Generated CLI commands ask the server to check confirmation after it parses the input. */
export const operationConfirmationHeader = "x-vitehub-confirmation"

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

/**
 * The MCP tool name of an operation: every character outside `[a-zA-Z0-9_-]` becomes `_`, since clients such as
 * Claude reject a dot in a tool name. `content.publish` is `content_publish`.
 */
export function operationToolName(name: string): string {
  return name.replace(/[^\w-]/g, "_")
}

/** Build the registry by name. A duplicate name or CLI command fails with `INTERNAL_B0048` or `INTERNAL_B0049`, two MCP tool names that match with `INTERNAL_B0050`. */
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
  const tools = new Map<string, AnyOperation>()
  for (const operation of operations) {
    if (operation.mcp === false) continue
    const tool = operationToolName(operation.name)
    const other = tools.get(tool)
    if (other) {
      throw internalErrorDiagnostics.INTERNAL_B0050({ message: `[vitehub] The operations ${JSON.stringify(other.name)} and ${JSON.stringify(operation.name)} are both the MCP tool ${JSON.stringify(tool)}.` })
    }
    tools.set(tool, operation)
  }
  return { get: name => byName.get(name)?.operation, list: () => [...operations] }
}

/**
 * What `console.authorize` allows for a person. Agents and MCP have no browser request, so the Console installs this
 * resolver, and it calls `authorize` with a request that carries no headers. Without `console.authorize` it returns
 * `"all"`, and the `include` list of the agent is the only gate.
 */
export type OperationSectionResolver = (call: { actor?: OperationActor, user: OperationUser | null }) => Promise<"all" | readonly string[]>

export { installOperationRegistry, installOperationRegistryLoader, installOperationSectionResolver, installedOperationRegistry, installedOperationSectionResolver } from "./operation-registry.ts"

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

/**
 * The section that grants a call, or `false` for any Console user. `undefined` means the input names no valid section.
 * A scoped operation answers `"<section>:<scope>"`, such as `"blob:media"`.
 */
export function operationSection(operation: Pick<AnyOperation, "scope" | "section">, input: unknown): string | false | undefined {
  const section = operation.section
  if (section instanceof Function) {
    // SAFETY: Callers pass input that the operation schema accepted.
    const resolved = (section as (value: unknown) => string | undefined)(input)
    return isSectionId(resolved) ? resolved : undefined
  }
  if (section === false) return section
  if (!isSectionId(section)) return undefined
  if (!operation.scope) return section
  // SAFETY: Callers pass input that the operation schema accepted.
  const scope = (operation.scope as (value: unknown) => string | undefined)(input)
  return isSectionScope(scope) ? `${section}:${scope}` : section
}

/** The suffix of a section grant that allows only reads, such as `"kv:read"`. */
export const readOnlySectionSuffix = ":read"


function isSectionScope(scope: unknown): scope is string {
  return isSectionId(scope) && scope !== "read"
}

/** `"blob:media"` → `["blob:media", "blob"]`: a grant of the section covers each of its scopes. */
function grantsFor(section: string): string[] {
  const separator = section.indexOf(":")
  return separator === -1 ? [section] : [section, section.slice(0, separator)]
}

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
  if (section === undefined) return false
  if (section === false || access.sections === "all") return true
  const { sections } = access
  const grants = grantsFor(section)
  if (grants.some(grant => sections.includes(grant))) return true
  if (!grants.some(grant => sections.includes(`${grant}${readOnlySectionSuffix}`))) return false
  return call === undefined || call.kind === "read" || call.readOnly === true
}

/**
 * Whether a tool list shows the operation to this access. An operation that reads its section from the input always
 * shows. A scoped operation also shows when the access grants one scope of its section, such as `"blob:media"`. Each
 * call checks its own section again.
 */
export function operationListed(access: OperationAccess, operation: Pick<AnyOperation, "scope" | "section">, call?: OperationCallKind): boolean {
  const { section } = operation
  if (section instanceof Function || operationAccessAllows(access, section, call)) return true
  if (section === false || !operation.scope || access.sections === "all") return false
  return access.sections.some((grant) => {
    if (!grant.startsWith(`${section}:`)) return false
    const scoped = grant.endsWith(readOnlySectionSuffix) ? grant.slice(0, -readOnlySectionSuffix.length) : grant
    return scoped !== section && operationAccessAllows(access, scoped, call)
  })
}

/**
 * Why the access refuses a call to a section, with the `console.authorize` grant that would allow it. A scoped section,
 * such as `"blob:default"`, names the scope and the whole section.
 */
export function operationAccessDenial(operationName: string, section: string | false | undefined): { fix: string, message: string } {
  if (!section) return { fix: "Check the input of the call.", message: `The input of ${operationName} names no section that this access can check.` }
  const separator = section.indexOf(":")
  if (separator === -1) return { fix: `Return ${JSON.stringify(section)} in the sections of console.authorize.`, message: `This access does not include the ${JSON.stringify(section)} section, which ${operationName} needs.` }
  const parent = section.slice(0, separator)
  return {
    fix: `Return ${JSON.stringify(section)} (only this scope) or ${JSON.stringify(parent)} (every scope) in the sections of console.authorize.`,
    message: `This access does not include ${JSON.stringify(section)}. ${operationName} needs it for the ${JSON.stringify(section.slice(separator + 1))} scope of the ${JSON.stringify(parent)} section.`,
  }
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
    return await runParsedOperation(operation, parsed, context, options)
  }
  catch (error) {
    return { ok: false, ...failure(error) }
  }
}

/** Run input already validated by parseOperationInput, so approval and execution can share one normalization. */
export async function runParsedOperation(operation: AnyOperation, parsed: unknown, context: OperationContext, options: RunOperationOptions = {}): Promise<OperationResult> {
  const failure = options.failure ?? toOperationFailure
  try {
    const section = operationSection(operation, parsed)
    if (!operationAccessAllows(context.access, section)) {
      const denial = operationAccessDenial(operation.name, section)
      throw Object.assign(internalErrorDiagnostics.INTERNAL_R0023({ message: `${denial.message} ${denial.fix}` }), { status: 403 })
    }
    if (!operationAccessAllows(context.access, section, operationCall(operation, parsed))) {
      throw Object.assign(internalErrorDiagnostics.INTERNAL_R0023({ message: `This access to the ${JSON.stringify(section)} section is read-only, and ${operation.name} is a ${operation.kind} operation. Grant the section without ":read" to allow it.` }), { status: 403 })
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
  /** Generated commands set this after --yes or a prompt. False requires confirmation if the server parses a destructive call. */
  confirmed?: boolean
  /**
   * Project roots that the caller accepts. The server checks their hashes before dispatch and rejects a mismatch
   * with `INTERNAL_R0025`. The response identity is also checked. These discovered development targets never receive
   * deployment credentials; pass an explicit URL without roots to use them.
   */
  roots?: readonly string[]
}

export const operationCredentialHint = "Set VITEHUB_CONSOLE_PRIVATE_KEY_<NAME> to a private key that `vitehub secret console-key` printed, and its public key in VITEHUB_CONSOLE_KEY_<NAME> on the app."

/** Headers of an operation call, without a signature. */
export function operationHeaders(): Headers {
  const headers = new Headers()
  headers.set("accept", "application/json")
  headers.set("content-type", "application/json")
  headers.set(operationRpcHeader, "1")
  headers.set(operationSurfaceHeader, "cli")
  return headers
}

/**
 * The headers of one operation call to a deployed app: {@link operationHeaders}, and the signature of `body` when the
 * env has a `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`. The CLI signs as itself, `via: "cli"`. Throws a `TypeError` for a
 * malformed private key.
 */
export async function signedOperationHeaders(env: Record<string, string | undefined>, url: string | URL, body: string): Promise<Headers> {
  const headers = operationHeaders()
  const key = readConsoleSigningKey(env)
  if (key) {
    const signed = await signConsoleRequest({ body, caller: { via: "cli" }, key, method: "POST", url })
    for (const [name, value] of Object.entries(signed)) headers.set(name, value)
  }
  return headers
}

function unreachable(message: string, status = 503): OperationResult {
  const error = internalErrorDiagnostics.INTERNAL_R0024({ message })
  return { ok: false, code: "INTERNAL_R0024", fix: Reflect.get(error, "fix") as string, message, status }
}

function hasCredentials(env: Record<string, string | undefined>): boolean {
  return Object.keys(env).some(name => name.startsWith("VITEHUB_CONSOLE_PRIVATE_KEY_") && Boolean(env[name]))
}

/** Refuse a stale local discovery target before dispatching any operation. */
export function assertOperationProject(request: Request, root: string | undefined): void {
  const expected = request.headers.get(operationExpectedRootsHeader)
  if (expected === null) return
  if (root && expected.split(",").includes(projectRootHash(root))) return
  throw Object.assign(internalErrorDiagnostics.INTERNAL_R0025({ message: "The server runs another project than the command expects." }), { status: 409 })
}

/**
 * Check a call that asks for confirmation against the same classification that the server will execute. Generated CLI
 * commands and the Console MCP send `x-vitehub-confirmation: required` until a person confirms.
 */
export function assertOperationConfirmation(request: Request, call: OperationCallKind): void {
  if (request.headers.get(operationConfirmationHeader) !== "required") return
  assertOperationConfirmed(call, false)
}

/** Refuse a destructive call that the caller did not confirm with `409` `INTERNAL_R0026`. Reads and writes pass. */
export function assertOperationConfirmed(call: OperationCallKind, confirmed: boolean): void {
  if (confirmed || call.kind !== "destructive" || call.readOnly) return
  throw Object.assign(internalErrorDiagnostics.INTERNAL_R0026(), { status: 409 })
}

/** Call one operation over the RPC of a dev server or a deployed app. Never throws. */
export async function callOperation(target: OperationTarget, name: string, input: unknown): Promise<OperationResult> {
  let origin = "the ViteHub app"
  try {
    const base = new URL(target.url)
    if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`
    const url = new URL(operationRpcPath.slice(1), base)
    origin = url.origin
    // A stale discovery file can point to another local service before its identity is checked.
    const env = target.roots?.length ? {} : target.env
    try {
      readConsoleSigningKey(env)
    }
    catch (error) {
      return { ok: false, code: "INTERNAL_R0024", fix: "Run `vitehub secret console-key` for a new key pair. Set its private key here and its public key on the app.", message: error instanceof Error ? error.message : String(error), status: 401 }
    }
    const outcome = await callOperationRpc(name, input ?? {}, async (body) => {
      // The signature covers the exact body, so the headers are made for each request.
      const headers = await signedOperationHeaders(env, url, body)
      if (target.confirmed !== undefined) headers.set(operationConfirmationHeader, target.confirmed ? "confirmed" : "required")
      if (target.roots?.length) headers.set(operationExpectedRootsHeader, target.roots.map(projectRootHash).join(","))
      const response = await (target.fetch ?? fetch)(url.href, {
        body,
        headers,
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(target.timeout ?? 30_000),
      })
      const text = await response.text()
      let json: unknown
      try {
        json = text ? JSON.parse(text) : undefined
      }
      catch {
        json = undefined
      }
      return { body: json, response }
    })
    const { response } = outcome.answer
    const served = response.headers.get(operationRootHeader)
    if (served && target.roots?.length && !target.roots.some(root => projectRootHash(root) === served)) {
      const message = `The server at ${url.origin} runs another project than ${target.roots[0]}.`
      const error = internalErrorDiagnostics.INTERNAL_R0025({ message })
      return { ok: false, code: "INTERNAL_R0025", fix: Reflect.get(error, "fix") as string, message, status: 409 }
    }
    if (outcome.ok) return { ok: true, value: outcome.value }
    // Host middleware, such as the Console sign-in check, answers with the diagnostic body and no birpc reply.
    const failure = outcome.error ?? readOperationRpcError(isObject(outcome.answer.body) ? { status: response.status, ...outcome.answer.body } : undefined)
    if (failure) {
      // A found dev server gets no credentials, so the fix that it sends for a 401 works only with --url.
      if (target.roots?.length && failure.status === 401) failure.fix = `Pass --url ${base.href.slice(0, -1)} to send credentials. A command sends none to the dev server that it finds. ${failure.fix ?? operationCredentialHint}`
      if ((failure.status === 401 || failure.status === 403) && !hasCredentials(env) && !failure.fix) failure.fix = target.roots?.length ? `Pass --url <origin> to send deployment credentials. ${operationCredentialHint}` : operationCredentialHint
      return { ok: false, ...failure }
    }
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      return unreachable(`${url.origin} asked for authentication (HTTP ${response.status}).`, 401)
    }
    return unreachable(`${url.origin} did not answer as a ViteHub app (HTTP ${response.status}). Pass the origin of an app that runs ViteHub.`, response.status)
  }
  catch (error) {
    return unreachable(`The request to ${origin} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** What a command-line tool passes to {@link callOperationFromCli}. */
export interface CliOperationCall {
  /** Whether the command confirmed a destructive call. */
  confirmed?: boolean
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
  return await callOperation({ ...(call.confirmed !== undefined ? { confirmed: call.confirmed } : {}), env: call.env, ...(call.fetch ? { fetch: call.fetch } : {}), ...(call.url ? {} : { roots }), ...(call.timeout ? { timeout: call.timeout } : {}), url }, name, input)
}

/** Align rows of text cells in columns for CLI output. The last column is not padded. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}
