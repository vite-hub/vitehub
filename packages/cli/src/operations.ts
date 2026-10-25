import { createInterface } from "node:readline/promises"

import { resolveViteHubDevServerUrl } from "@vite-hub/internal/cli"
import { callOperation, collectOperationContributions, createOperationRegistry, operationInputJsonSchema, operationsOf } from "@vite-hub/internal/operations"
import { flattenPluginOptions } from "@vite-hub/internal/contributions"

import { cliErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliCommandNamespace, ViteHubCliContext, ViteHubCliFeature } from "@vite-hub/internal/cli"
import type { AnyOperation, OperationFailure } from "@vite-hub/internal/operations"

type JsonSchema = Record<string, unknown>

interface Flag {
  /** The key of the operation input. */
  key: string
  description?: string
  required: boolean
  type: "array" | "boolean" | "integer" | "number" | "object" | "string"
}

/** Reads every contributed operation of the resolved plugins. A module that fails to load is reported on stderr. */
export async function loadCliOperations(plugins: readonly unknown[], stderr: ViteHubCliContext["stderr"]): Promise<AnyOperation[]> {
  const sources: Array<{ operations: AnyOperation[], plugin: string }> = []
  for (const contribution of collectOperationContributions(await flattenPluginOptions(plugins))) {
    try {
      const exported = contribution.load ? await contribution.load() : Reflect.get(Object(await import(/* @vite-ignore */ contribution.module)), contribution.export)
      sources.push({ operations: operationsOf(exported), plugin: contribution.plugin })
    }
    catch (error) {
      stderr.write(`Could not load the operations of ${contribution.plugin} from ${contribution.module}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return createOperationRegistry(sources).list()
}

function namespaceOf(operation: AnyOperation): string {
  return operation.cli?.namespace ?? (typeof operation.section === "string" ? operation.section : operation.name.slice(0, operation.name.indexOf(".")))
}

function commandOf(operation: AnyOperation): string {
  return operation.cli?.command ?? operation.name.slice(operation.name.indexOf(".") + 1)
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

function camel(flag: string): string {
  return flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function flagType(schema: unknown): Flag["type"] {
  const value = schema !== null && Object(schema) === schema ? Reflect.get(Object(schema), "type") : undefined
  if (Array.isArray(value)) return flagType({ type: value.find(entry => entry !== "null") })
  if (value === "array" || value === "boolean" || value === "integer" || value === "number" || value === "object" || value === "string") return value
  // A union such as `string | null` has `anyOf` or `oneOf`.
  const alternatives: unknown = schema !== null && Object(schema) === schema ? Reflect.get(Object(schema), "anyOf") ?? Reflect.get(Object(schema), "oneOf") : undefined
  if (Array.isArray(alternatives)) {
    const found = alternatives.map(flagType).find(type => type !== "string") ?? "string"
    return found
  }
  return "string"
}

function flagsOf(operation: AnyOperation): Flag[] {
  const schema: JsonSchema = operationInputJsonSchema(operation)
  const properties = schema.properties !== null && Object(schema.properties) === schema.properties ? Object.entries(schema.properties as JsonSchema) : []
  const required = Array.isArray(schema.required) ? schema.required.map(String) : []
  return properties.map(([key, property]): Flag => {
    const description = property !== null && Object(property) === property ? Reflect.get(Object(property), "description") : undefined
    return { key, required: required.includes(key), type: flagType(property), ...(String(description) === description ? { description } : {}) }
  })
}

function usageOf(operation: AnyOperation, flags: readonly Flag[]): string {
  const positional = operation.cli?.positional ?? []
  const names = positional.map((key) => {
    const flag = flags.find(entry => entry.key === key)
    return flag?.required === false ? `[${kebab(key)}]` : `<${kebab(key)}>`
  })
  const options = flags.filter(flag => !positional.includes(flag.key)).map((flag) => {
    const name = `--${kebab(flag.key)}${flag.type === "boolean" ? "" : " <value>"}`
    return flag.required ? name : `[${name}]`
  })
  return ["vitehub", namespaceOf(operation), commandOf(operation), ...names, ...options, "[--json]", ...(operation.kind === "destructive" ? ["[--yes]"] : []), "[--url <origin>]"].join(" ")
}

function helpOf(operation: AnyOperation, flags: readonly Flag[]): string {
  const positional = operation.cli?.positional ?? []
  const lines = [`Usage: ${usageOf(operation, flags)}`, "", operation.description, ""]
  const described = flags.map(flag => `  ${positional.includes(flag.key) ? `<${kebab(flag.key)}>` : `--${kebab(flag.key)}`}  ${flag.type}${flag.required ? ", required" : ""}${flag.description ? `. ${flag.description}` : ""}`)
  if (described.length) lines.push("Input:", ...described, "")
  lines.push(
    "Options:",
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

function convert(flag: Flag | undefined, name: string, raw: string): unknown {
  switch (flag?.type) {
    case "integer":
    case "number": {
      const value = Number(raw)
      if (raw.trim() === "" || !Number.isFinite(value)) throw usageError(`--${name} must be a number.`)
      return value
    }
    case "boolean": return raw !== "false"
    case "object":
      try {
        return JSON.parse(raw)
      }
      catch {
        throw usageError(`--${name} must be JSON.`)
      }
    default: return raw
  }
}

function assign(input: Record<string, unknown>, flag: Flag | undefined, key: string, name: string, raw: string): void {
  if (flag?.type === "array") {
    const items = raw.trim().startsWith("[") ? JSON.parse(raw) as unknown[] : raw.split(",").map(item => item.trim()).filter(Boolean)
    input[key] = [...(Array.isArray(input[key]) ? input[key] : []), ...items]
    return
  }
  input[key] = convert(flag, name, raw)
}

function parseCall(operation: AnyOperation, flags: readonly Flag[], args: readonly string[]): ParsedCall {
  const parsed: ParsedCall = { help: false, input: {}, json: false, yes: false }
  const positional = [...(operation.cli?.positional ?? [])]
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
      let value: string | undefined = equals === -1 ? undefined : arg.slice(equals + 1)
      const take = (): string => {
        if (value !== undefined) return value
        const next = args[index + 1]
        if (next === undefined || next.startsWith("--")) throw usageError(`Option --${name} needs a value.`)
        index++
        return next
      }
      if (name === "url") parsed.url = take()
      else if (name === "timeout") {
        const timeout = Number(take())
        if (!Number.isInteger(timeout) || timeout < 1) throw usageError("--timeout must be a whole number of milliseconds.")
        parsed.timeout = timeout
      }
      else {
        const negated = name.startsWith("no-") && flags.some(flag => flag.key === camel(name.slice(3)) && flag.type === "boolean")
        const key = camel(negated ? name.slice(3) : name)
        const flag = flags.find(entry => entry.key === key)
        if (!flag) throw usageError(`Unknown option --${name}. Run \`vitehub ${namespaceOf(operation)} ${commandOf(operation)} --help\` for the input.`)
        if (flag.type === "boolean") {
          const next = args[index + 1]
          parsed.input[key] = negated ? false : value !== undefined ? value !== "false" : next === "true" || next === "false" ? (index++, next === "true") : true
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

function featureOf(operation: AnyOperation): ViteHubCliFeature {
  const flags = flagsOf(operation)
  return {
    description: operation.description,
    name: commandOf(operation),
    async run(args, context) {
      let parsed: ParsedCall
      try {
        parsed = parseCall(operation, flags, args)
      }
      catch (error) {
        const failure: OperationFailure = { code: String(Reflect.get(Object(error), "code")), fix: String(Reflect.get(Object(error), "fix")), message: error instanceof Error ? error.message : String(error), status: 400 }
        if (args.includes("--json")) return writeFailure(failure, { json: true }, context)
        context.stderr.write(`${failure.message}\nUsage: ${usageOf(operation, flags)}\n`)
        return 1
      }
      if (parsed.help) {
        context.stdout.write(helpOf(operation, flags))
        return 0
      }
      const target = parsed.url ?? resolveViteHubDevServerUrl(context.env)
      // A dry run only reads, so it does not need the confirmation of a destructive operation.
      const reads = parsed.input.dryRun === true
      if (operation.kind === "destructive" && !parsed.yes && !reads) {
        if (!(process.stdin.isTTY && process.stderr.isTTY) || !await confirm(operation, target)) {
          const error = cliErrorDiagnostics.CLI_R0004({ message: `${operation.name} changes or removes data and was not confirmed.` })
          return writeFailure({ code: "CLI_R0004", fix: Reflect.get(error, "fix") as string, message: error.message, status: 400 }, parsed, context)
        }
      }
      const result = await callOperation({
        env: context.env,
        ...(context.fetch ? { fetch: context.fetch } : {}),
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
    const name = namespaceOf(operation)
    const namespace = namespaces.get(name) ?? { description: `Run the ${name} operations of the app.`, features: [], name }
    namespace.features.push(featureOf(operation))
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
  }
  return merged
}
