import { readFileSync } from "node:fs"
import { createInterface } from "node:readline/promises"

import { findViteHubDevServerUrl } from "@vite-hub/internal/cli"
import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { flattenPluginOptions } from "@vite-hub/internal/contributions"
import { resolveViteHubDispatchKey, signViteHubDispatch } from "@vite-hub/internal/dispatch"
import { isSecretInspectionKey, redactInspectionText, redactedInspectionValue } from "@vite-hub/internal/inspect"
import { callOperation, collectOperationContributions, createOperationRegistry, operationCall, operationCliPath, operationInputJsonSchema, operationsOf, parseOperationInput } from "@vite-hub/internal/operations"
import { resolve } from "pathe"

import { cliErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliCommandNamespace, ViteHubCliContext, ViteHubCliFeature } from "@vite-hub/internal/cli"
import type { AnyOperation, OperationFailure, OperationResult } from "@vite-hub/internal/operations"

type JsonSchema = Record<string, unknown>

/** How a flag reads its text. `json` flags take a JSON document, such as `--body '{"a":1}'`. */
type FlagType = "boolean" | "integer" | "json" | "list" | "number" | "string"

interface Flag {
  description?: string
  /** The type of the items of a `list`. */
  item?: FlagType
  /** The flag may be the literal `null`. */
  nullable: boolean
  /** A union of scalars, such as `string | number`, tried in this order. */
  alternatives: FlagType[]
  /** The key of the operation input. */
  key: string
  required: boolean
  type: FlagType
}

/** Reads every contributed operation of the resolved plugins. A module that fails to load is reported on stderr. */
export async function loadCliOperations(plugins: readonly unknown[], stderr: ViteHubCliContext["stderr"]): Promise<AnyOperation[]> {
  const sources: Array<{ operations: AnyOperation[], plugin: string }> = []
  for (const contribution of await collectOperationContributions(await flattenPluginOptions(plugins))) {
    try {
      const exported = contribution.load ? await contribution.load() : Reflect.get(Object(await import(/* @vite-ignore */ contribution.module)), contribution.export)
      sources.push({ operations: operationsOf(exported), plugin: contribution.plugin })
    }
    catch (error) {
      stderr.write(`Could not load the operations of ${contribution.plugin} from ${contribution.module}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  // Two commands with one name fail here, with INTERNAL_B0049.
  return createOperationRegistry(sources).list()
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

function camel(flag: string): string {
  return flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function isObject(value: unknown): value is JsonSchema {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

const scalarTypes: ReadonlySet<string> = new Set(["boolean", "integer", "number", "string"])

/** Reads the type of a JSON Schema node. Objects, unknown values, and lists of objects are JSON. */
function readType(schema: unknown): { alternatives: FlagType[], item?: FlagType, nullable: boolean, type: FlagType } {
  if (!isObject(schema)) return { alternatives: [], nullable: false, type: "json" }
  const options = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined
  if (options) {
    const parts = options.map(readType)
    const nulls = options.filter(option => isObject(option) && option.type === "null").length
    const present = parts.filter((_part, index) => !(isObject(options[index]) && (options[index] as JsonSchema).type === "null"))
    const nullable = nulls > 0 || parts.some(part => part.nullable)
    if (present.length === 1) return { ...present[0]!, nullable }
    const scalars = present.map(part => part.type)
    if (scalars.every(type => type !== "json" && type !== "list")) {
      // A union with a string stays a string. Without one, the value takes the first scalar type that it parses as.
      return { alternatives: scalars.includes("string") ? ["string"] : scalars, nullable, type: scalars.includes("string") ? "string" : scalars[0]! }
    }
    return { alternatives: [], nullable, type: "json" }
  }
  const declared = schema.type
  if (Array.isArray(declared)) {
    const kinds = declared.filter(kind => kind !== "null")
    const nullable = declared.includes("null")
    return kinds.length === 1 ? { ...readType({ ...schema, type: kinds[0] }), nullable } : { alternatives: [], nullable, type: "json" }
  }
  if (typeof declared === "string" && scalarTypes.has(declared)) return { alternatives: [], nullable: false, type: declared as FlagType }
  if (declared === "array") {
    const items = readType(schema.items)
    return items.type === "json" || items.type === "list" ? { alternatives: [], nullable: false, type: "json" } : { alternatives: [], item: items.type, nullable: false, type: "list" }
  }
  if (Array.isArray(schema.enum) && schema.enum.every(value => typeof value === "string")) return { alternatives: [], nullable: false, type: "string" }
  if (typeof schema.const === "string") return { alternatives: [], nullable: false, type: "string" }
  return { alternatives: [], nullable: false, type: "json" }
}

function flagsOf(operation: AnyOperation): Flag[] {
  const schema = operationInputJsonSchema(operation)
  const properties = isObject(schema.properties) ? Object.entries(schema.properties) : []
  const required = Array.isArray(schema.required) ? schema.required.map(String) : []
  return properties.map(([key, property]): Flag => {
    const description = isObject(property) ? property.description : undefined
    return { ...readType(property), key, required: required.includes(key), ...(typeof description === "string" ? { description } : {}) }
  })
}

function usageOf(operation: AnyOperation, flags: readonly Flag[]): string {
  const { command, namespace } = operationCliPath(operation)
  const positional = operation.cli?.positional ?? []
  const names = positional.map((key) => {
    const flag = flags.find(entry => entry.key === key)
    return flag?.required === false ? `[${kebab(key)}]` : `<${kebab(key)}>`
  })
  const options = flags.filter(flag => !positional.includes(flag.key)).map((flag) => {
    const name = `--${kebab(flag.key)}${flag.type === "boolean" ? "" : " <value>"}`
    return flag.required ? name : `[${name}]`
  })
  return ["vitehub", namespace, command, ...names, ...options, "[--input <json|@file>]", "[--json]", ...(operation.kind === "destructive" ? ["[--yes]"] : []), "[--url <origin>]"].join(" ")
}

function describeFlag(flag: Flag): string {
  const base = flag.type === "json" ? "JSON" : flag.type === "list" ? "list (repeat the flag or separate with commas)" : flag.type
  return `${base}${flag.nullable ? " or null" : ""}${flag.required ? ", required" : ""}`
}

function helpOf(operation: AnyOperation, flags: readonly Flag[]): string {
  const positional = operation.cli?.positional ?? []
  const lines = [`Usage: ${usageOf(operation, flags)}`, "", operation.description, ""]
  const described = flags.map(flag => `  ${positional.includes(flag.key) ? `<${kebab(flag.key)}>` : `--${kebab(flag.key)}`}  ${describeFlag(flag)}${flag.description ? `. ${flag.description}` : ""}`)
  if (described.length) lines.push("Input:", ...described, "")
  lines.push(
    "Options:",
    "  --input <json|@file>  Pass the whole input as JSON or from a file. Flags override it.",
    "  --json         Print JSON.",
    ...(operation.kind === "destructive" ? ["  --yes          Run without asking. This operation changes or removes data."] : []),
    "  --url <origin> Call a deployed app. Without it the command calls the running dev server.",
    "  --timeout <ms> Wait this long for the answer. Default 30000.",
    "  -h, --help     Show this help.",
    "",
  )
  return lines.join("\n")
}

interface ParsedCall {
  help: boolean
  input: Record<string, unknown>
  json: boolean
  timeout?: number
  url?: string
  yes: boolean
}

function usageError(message: string): Error {
  return cliErrorDiagnostics.CLI_R0003({ message })
}

function parseJson(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw)
  }
  catch (error) {
    throw usageError(`--${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function convertScalar(type: FlagType, name: string, raw: string): unknown {
  switch (type) {
    case "integer":
    case "number": {
      const value = Number(raw)
      if (raw.trim() === "" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) throw usageError(`--${name} must be ${type === "integer" ? "a whole number" : "a number"}.`)
      return value
    }
    case "boolean":
      if (raw !== "true" && raw !== "false") throw usageError(`--${name} must be true or false.`)
      return raw === "true"
    case "json": return parseJson(raw, name)
    default: return raw
  }
}

function convert(flag: Flag | undefined, name: string, raw: string): unknown {
  if (!flag) return raw
  if (flag.nullable && raw === "null") return null
  if (flag.alternatives.length > 1) {
    // A string|number union stays a string. Other unions take the first type that the text parses as.
    for (const type of flag.alternatives) {
      try {
        return convertScalar(type, name, raw)
      }
      catch {
        continue
      }
    }
    throw usageError(`--${name} must be one of: ${flag.alternatives.join(", ")}.`)
  }
  return convertScalar(flag.type, name, raw)
}

function assign(input: Record<string, unknown>, flag: Flag | undefined, key: string, name: string, raw: string): void {
  if (flag?.type === "list") {
    if (flag.nullable && raw === "null") {
      input[key] = null
      return
    }
    const items = raw.trim().startsWith("[") ? parseJson(raw, name) : raw.split(",").map(item => item.trim()).filter(Boolean).map(item => convertScalar(flag.item ?? "string", name, item))
    if (!Array.isArray(items)) throw usageError(`--${name} must be a list.`)
    input[key] = [...(Array.isArray(input[key]) ? input[key] : []), ...items]
    return
  }
  input[key] = convert(flag, name, raw)
}

/** `--input '{"a":1}'` or `--input @file.json`. */
function readWholeInput(raw: string, cwd: string): Record<string, unknown> {
  let text = raw
  if (raw.startsWith("@")) {
    try {
      text = readFileSync(resolve(cwd, raw.slice(1)), "utf8")
    }
    catch (error) {
      throw usageError(`--input could not read ${raw.slice(1)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const value = parseJson(text, "input")
  if (!isObject(value)) throw usageError("--input must be a JSON object.")
  return value
}

function parseCall(operation: AnyOperation, flags: readonly Flag[], args: readonly string[], cwd: string): ParsedCall {
  const parsed: ParsedCall = { help: false, input: {}, json: false, yes: false }
  const positional = [...(operation.cli?.positional ?? [])]
  const { command, namespace } = operationCliPath(operation)
  let whole: Record<string, unknown> = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      for (const rest of args.slice(index + 1)) {
        const key = positional.shift()
        if (!key) throw usageError(`Unexpected argument ${JSON.stringify(rest)}.`)
        assign(parsed.input, flags.find(flag => flag.key === key), key, kebab(key), rest)
      }
      break
    }
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--json") parsed.json = true
    else if (arg === "--yes" || arg === "-y") parsed.yes = true
    else if (arg.startsWith("--")) {
      const equals = arg.indexOf("=")
      const name = arg.slice(2, equals === -1 ? undefined : equals)
      const inline: string | undefined = equals === -1 ? undefined : arg.slice(equals + 1)
      const take = (): string => {
        if (inline !== undefined) return inline
        const next = args[index + 1]
        if (next === undefined || (next.startsWith("--") && next !== "--")) throw usageError(`Option --${name} needs a value.`)
        index++
        return next
      }
      if (name === "url") parsed.url = take()
      else if (name === "input") whole = readWholeInput(take(), cwd)
      else if (name === "timeout") {
        const timeout = Number(take())
        if (!Number.isInteger(timeout) || timeout < 1) throw usageError("--timeout must be a whole number of milliseconds.")
        parsed.timeout = timeout
      }
      else {
        const negated = name.startsWith("no-") && flags.some(flag => flag.key === camel(name.slice(3)) && flag.type === "boolean")
        const key = camel(negated ? name.slice(3) : name)
        const flag = flags.find(entry => entry.key === key)
        if (!flag) throw usageError(`Unknown option --${name}. Run \`vitehub ${namespace} ${command} --help\` for the input.`)
        if (flag.type === "boolean") {
          const next = args[index + 1]
          const value = inline !== undefined ? convertScalar("boolean", name, inline) : !negated && (next === "true" || next === "false") ? (index++, next === "true") : true
          parsed.input[key] = negated ? false : value
        }
        else assign(parsed.input, flag, key, name, take())
      }
    }
    else {
      const key = positional.shift()
      if (!key) throw usageError(`Unexpected argument ${JSON.stringify(arg)}.`)
      assign(parsed.input, flags.find(flag => flag.key === key), key, kebab(key), arg)
    }
  }
  // Flags and positionals override the whole input.
  parsed.input = { ...whole, ...parsed.input }
  return parsed
}

function writeFailure(failure: OperationFailure, parsed: Pick<ParsedCall, "json">, context: ViteHubCliContext): number {
  if (parsed.json) {
    context.stdout.write(`${JSON.stringify({ error: { code: failure.code, ...(failure.details ? { details: failure.details } : {}), ...(failure.docs ? { docs: failure.docs } : {}), ...(failure.fix ? { fix: failure.fix } : {}), message: failure.message } }, null, 2)}\n`)
    return 1
  }
  context.stderr.write([`${failure.code}: ${failure.message}`, ...(failure.fix ? [`Fix: ${failure.fix}`] : []), ...(failure.docs ? [`Docs: ${failure.docs}`] : []), ""].join("\n"))
  return 1
}

/** A coded failure for a thrown diagnostic. */
function failureOf(error: unknown, status = 400): OperationFailure {
  const code = Reflect.get(Object(error), "code")
  const fix = Reflect.get(Object(error), "fix")
  return {
    code: typeof code === "string" && code ? code : "CLI_R0003",
    ...(typeof fix === "string" && fix ? { fix } : {}),
    message: error instanceof Error ? error.message : String(error),
    status,
  }
}

async function confirm(operation: AnyOperation, target: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await terminal.question(`${operation.description} This changes data at ${target}. Continue? [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  }
  finally {
    terminal.close()
  }
}

/** The roots that the CLI accepts a dev server for: the Vite root and the ViteHub project root. */
function acceptedRoots(rootDir: string): string[] {
  const roots = new Set([rootDir])
  try {
    roots.add(resolveViteHubProjectRoot(rootDir))
  }
  catch {
    // The Vite root alone is enough to compare.
  }
  return [...roots]
}

/**
 * Where a command sends its call: `--url`, else the dev server that wrote `.vitehub/dev-server.json` in this project,
 * else `VITEHUB_DEV_SERVER_URL`. There is no guess: another project may use port 5173.
 */
function resolveTarget(parsed: ParsedCall, context: ViteHubCliContext): { target: string } | { failure: OperationFailure } {
  if (parsed.url) {
    let base: URL
    try {
      base = new URL(parsed.url)
    }
    catch {
      return { failure: failureOf(cliErrorDiagnostics.CLI_R0003({ message: "--url must be a URL." })) }
    }
    const local = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]"
    if (base.protocol !== "https:" && !(local && base.protocol === "http:")) {
      return { failure: failureOf(cliErrorDiagnostics.CLI_R0003({ message: "--url must use HTTPS, except for localhost." })) }
    }
    if (base.username || base.password || base.search || base.hash) {
      return { failure: failureOf(cliErrorDiagnostics.CLI_R0003({ message: "--url must not contain credentials, a query, or a fragment." })) }
    }
    return { target: parsed.url }
  }
  const found = findViteHubDevServerUrl(acceptedRoots(context.rootDir), context.env)
  if (found) return { target: found }
  const error = cliErrorDiagnostics.CLI_R0005({ message: `No dev server is running for ${context.rootDir}.` })
  return { failure: failureOf(error, 503) }
}

/**
 * Posts a signed dispatch to the route of an operation on a deployed app. Returns undefined when no dispatch key is set,
 * so the command falls back to the RPC with Console credentials.
 */
async function callDispatch(operation: string, route: string, url: string, input: unknown, context: ViteHubCliContext, timeout: number | undefined): Promise<OperationResult | undefined> {
  const base = new URL(url)
  let key: string | undefined
  try {
    key = await resolveViteHubDispatchKey(context.env)
  }
  catch (error) {
    return { ...failureOf(cliErrorDiagnostics.CLI_R0003({ message: error instanceof Error ? error.message : String(error) })), ok: false }
  }
  if (!key) return undefined
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`
  const target = new URL(route.slice(1), base)
  const body = JSON.stringify(input ?? {})
  const actor = context.env.VITEHUB_ACTOR || context.env.USER || context.env.USERNAME || undefined
  const headers = new Headers({ accept: "application/json", "content-type": "application/json", ...await signViteHubDispatch({ actor, body, key, operation }) })
  if (context.env.CF_ACCESS_CLIENT_ID) headers.set("cf-access-client-id", context.env.CF_ACCESS_CLIENT_ID)
  if (context.env.CF_ACCESS_CLIENT_SECRET) headers.set("cf-access-client-secret", context.env.CF_ACCESS_CLIENT_SECRET)
  let response: Response
  let text: string
  try {
    response = await (context.fetch ?? fetch)(target.href, { body, headers, method: "POST", redirect: "manual", signal: AbortSignal.timeout(timeout ?? 30_000) })
    text = await response.text()
  }
  catch (error) {
    return { ...failureOf(cliErrorDiagnostics.CLI_R0006({ message: `The signed request to ${target.origin} failed: ${redactInspectionText(error instanceof Error ? error.message : String(error))}` }), 502), ok: false }
  }
  let json: unknown
  try {
    // Share inspection's secret-key policy without its output size limits.
    json = text ? JSON.parse(text, (key, value: unknown) => isSecretInspectionKey(key) ? redactedInspectionValue : typeof value === "string" ? redactInspectionText(value) : value) : undefined
  }
  catch {
    json = undefined
  }
  if (response.ok && json !== undefined) return { ok: true, value: json }
  const message = Reflect.get(Object(json), "message")
  const failure = failureOf(cliErrorDiagnostics.CLI_R0006({ message: `The signed request failed with HTTP ${response.status}${typeof message === "string" && message ? `: ${message}` : "."}` }), response.status)
  if (response.status === 401) failure.fix = "Set VITEHUB_DISPATCH_KEY to the key of the app (`vitehub secret derive vitehub:dispatch` prints it), and keep the clock of this machine correct."
  return { ...failure, ok: false }
}

function featureOf(operation: AnyOperation): ViteHubCliFeature {
  const flags = flagsOf(operation)
  const { command } = operationCliPath(operation)
  return {
    description: operation.description,
    name: command,
    async run(args, context) {
      let parsed: ParsedCall
      try {
        parsed = parseCall(operation, flags, args, context.cwd)
      }
      catch (error) {
        const failure = failureOf(error)
        if (args.includes("--json")) return writeFailure(failure, { json: true }, context)
        context.stderr.write(`${failure.message}\nUsage: ${usageOf(operation, flags)}\n`)
        return 1
      }
      if (parsed.help) {
        context.stdout.write(helpOf(operation, flags))
        return 0
      }
      let reads: boolean
      try {
        reads = operationCall(operation, await parseOperationInput(operation, parsed.input)).readOnly === true
      }
      catch (error) {
        return writeFailure(failureOf(error), parsed, context)
      }
      const resolved = resolveTarget(parsed, context)
      if ("failure" in resolved) return writeFailure(resolved.failure, parsed, context)
      const target = resolved.target
      let confirmed = parsed.yes
      // A call that only reads, such as a dry run, needs no confirmation.
      if (operation.kind === "destructive" && !parsed.yes && !reads) {
        if (!(process.stdin.isTTY && process.stderr.isTTY) || !await confirm(operation, target)) {
          return writeFailure(failureOf(cliErrorDiagnostics.CLI_R0004({ message: `${operation.name} changes or removes data and was not confirmed.` })), parsed, context)
        }
        confirmed = true
      }
      // The server parses the original input once and verifies confirmation against that result.
      const dispatch = operation.cli?.dispatch && parsed.url ? await callDispatch(operation.name, operation.cli.dispatch, parsed.url, parsed.input, context, parsed.timeout) : undefined
      const result = dispatch ?? await callOperation({
        confirmed,
        env: context.env,
        ...(context.fetch ? { fetch: context.fetch } : {}),
        ...(parsed.url ? {} : { roots: acceptedRoots(context.rootDir) }),
        ...(parsed.timeout ? { timeout: parsed.timeout } : {}),
        url: target,
      }, operation.name, parsed.input)
      if (!result.ok) return writeFailure(result, parsed, context)
      const format = operation.cli?.format as ((output: unknown) => string) | undefined
      const output = !parsed.json && format ? format(result.value) : `${JSON.stringify(result.value ?? null, null, 2)}\n`
      context.stdout.write(output.endsWith("\n") ? output : `${output}\n`)
      return 0
    },
    usage: usageOf(operation, flags),
  }
}

/** One namespace per operation namespace, with a command for each operation. */
export function createOperationNamespaces(operations: readonly AnyOperation[]): ViteHubCliCommandNamespace[] {
  const namespaces = new Map<string, ViteHubCliCommandNamespace>()
  for (const operation of operations) {
    const { namespace: name } = operationCliPath(operation)
    const namespace = namespaces.get(name) ?? { description: `Run the ${name} operations of the app.`, features: [], name }
    namespace.features.push(featureOf(operation))
    if (operation.cli?.default) namespace.defaultFeature = operationCliPath(operation).command
    namespaces.set(name, namespace)
  }
  return [...namespaces.values()]
}

/**
 * Adds the generated namespaces to the ones that packages wrote by hand. A hand-written command with the same name wins,
 * since it can offer more than the generated one, such as an editor.
 */
export function mergeOperationNamespaces(written: readonly ViteHubCliCommandNamespace[], generated: readonly ViteHubCliCommandNamespace[]): ViteHubCliCommandNamespace[] {
  const merged = written.map(namespace => ({ ...namespace, features: [...namespace.features] }))
  for (const namespace of generated) {
    const existing = merged.find(candidate => candidate.name === namespace.name)
    if (!existing) {
      merged.push(namespace)
      continue
    }
    for (const feature of namespace.features) if (!existing.features.some(candidate => candidate.name === feature.name)) existing.features.push(feature)
    if (namespace.defaultFeature && !existing.defaultFeature) existing.defaultFeature = namespace.defaultFeature
  }
  return merged
}
