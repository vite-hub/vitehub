import { parseStandardSchema } from "@vite-hub/internal/http-request"

import { defineInternalTool } from "./capabilities/internal.ts"

import type {
  AgentCapabilityCliCommand,
  AgentCapabilityCliContribution,
  AgentCapabilityCliExecutionInput,
  AgentCapabilityCliExecutionResult,
  AgentCapabilityCliOutputDefinition,
  AgentCapabilityCliOutputFormat,
  AgentCapabilityCliStandardSchemaV1,
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  AgentToolDefinition,
  AgentToolSet,
} from "./types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

type CliNode<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName> =
  | AgentCapabilityCliContribution<TRuntimeConfig, Name>
  | AgentCapabilityCliCommand<TRuntimeConfig, Name>
type LeafCliCommand<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName> =
  AgentCapabilityCliCommand<TRuntimeConfig, Name> & {
    run: NonNullable<AgentCapabilityCliCommand<TRuntimeConfig, Name>["run"]>
  }

interface ResolvedCliCommand<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName> {
  argv: string[]
  command: LeafCliCommand<TRuntimeConfig, Name>
  input?: unknown
  json: boolean
  path: string[]
}

const stableCliName = /^[A-Za-z][A-Za-z0-9_-]*$/
const stableCommandName = /^[A-Za-z0-9_.-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isStandardSchema<T = unknown>(value: unknown): value is AgentCapabilityCliStandardSchemaV1<T> {
  return isRecord(value)
    && isRecord(value["~standard"])
    && typeof value["~standard"].validate === "function"
}

function assertCliName(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !stableCliName.test(value)) {
    throw new TypeError(`[vitehub] ${label} must be a stable CLI name.`)
  }
}

function assertCommandName(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !stableCommandName.test(value)) {
    throw new TypeError(`[vitehub] ${label} must be a stable command name without whitespace.`)
  }
}

function commandEntries<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  commands: unknown,
  label: string,
): Array<[string, AgentCapabilityCliCommand<TRuntimeConfig, Name>]> {
  if (!isRecord(commands) || !Object.keys(commands).length) {
    throw new TypeError(`[vitehub] ${label} requires at least one command.`)
  }
  return Object.entries(commands) as Array<[string, AgentCapabilityCliCommand<TRuntimeConfig, Name>]>
}

function assertCliNode<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  node: AgentCapabilityCliCommand<TRuntimeConfig, Name>,
  label: string,
): void {
  if (!isRecord(node)) throw new TypeError(`[vitehub] ${label} must be a command object.`)
  const hasChildren = node.commands !== undefined
  const hasRun = node.run !== undefined
  if (hasChildren === hasRun) {
    throw new TypeError(`[vitehub] ${label} must define either commands or run.`)
  }
  if (node.description !== undefined && typeof node.description !== "string") {
    throw new TypeError(`[vitehub] ${label} description must be a string.`)
  }
  if (node.effects !== undefined && (!Array.isArray(node.effects) || node.effects.some(effect => typeof effect !== "string" || !effect.trim()))) {
    throw new TypeError(`[vitehub] ${label} effects must be strings.`)
  }
  if (node.examples !== undefined && (!Array.isArray(node.examples) || node.examples.some(example => typeof example !== "string" || !example.trim()))) {
    throw new TypeError(`[vitehub] ${label} examples must be strings.`)
  }
  if (node.input !== undefined && !isStandardSchema(node.input)) {
    throw new TypeError(`[vitehub] ${label} input must be a Standard Schema.`)
  }
  if (node.output !== undefined && !isStandardSchema(node.output) && (!isRecord(node.output) || node.output.schema !== undefined && !isStandardSchema(node.output.schema))) {
    throw new TypeError(`[vitehub] ${label} output must be a Standard Schema or output metadata object.`)
  }
  if (isRecord(node.output) && node.output.format !== undefined && node.output.format !== "json" && node.output.format !== "text") {
    throw new TypeError(`[vitehub] ${label} output format must be "json" or "text".`)
  }
  if (hasRun && typeof node.run !== "function") {
    throw new TypeError(`[vitehub] ${label} run must be a function.`)
  }
  if (!node.commands) return
  for (const [name, child] of commandEntries<TRuntimeConfig, Name>(node.commands, `${label}.commands`)) {
    assertCommandName(name, `${label} command "${name}"`)
    assertCliNode(child, `${label}.${name}`)
  }
}

export function assertCapabilityCliContribution<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  capabilityId: string,
  cli: AgentCapabilityCliContribution<TRuntimeConfig, Name> | undefined,
): void {
  if (cli === undefined) return
  if (!isRecord(cli)) throw new TypeError(`[vitehub] Capability "${capabilityId}" cli must be an object.`)
  assertCliName(cli.name, `Capability "${capabilityId}" cli.name`)
  if (cli.description !== undefined && typeof cli.description !== "string") {
    throw new TypeError(`[vitehub] Capability "${capabilityId}" cli.description must be a string.`)
  }
  for (const [name, command] of commandEntries<TRuntimeConfig, Name>(cli.commands, `Capability "${capabilityId}" cli.commands`)) {
    assertCommandName(name, `Capability "${capabilityId}" cli command "${name}"`)
    assertCliNode(command, `Capability "${capabilityId}" cli.${name}`)
  }
}

function isLeaf<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  command: AgentCapabilityCliCommand<TRuntimeConfig, Name>,
): command is LeafCliCommand<TRuntimeConfig, Name> {
  return typeof command.run === "function"
}

function childCommands<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  node: CliNode<TRuntimeConfig, Name>,
): Record<string, AgentCapabilityCliCommand<TRuntimeConfig, Name>> | undefined {
  return node.commands
}

function commandLeaves<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  node: CliNode<TRuntimeConfig, Name>,
  prefix: string[] = [],
): Array<{ command: AgentCapabilityCliCommand<TRuntimeConfig, Name>, path: string[] }> {
  const children = childCommands(node)
  if (!children) return isLeaf(node as AgentCapabilityCliCommand<TRuntimeConfig, Name>) ? [{ command: node as AgentCapabilityCliCommand<TRuntimeConfig, Name>, path: prefix }] : []
  return Object.entries(children).flatMap(([name, command]) => commandLeaves(command, [...prefix, name]))
}

function firstExample(cliName: string, path: string[], command: AgentCapabilityCliCommand): string {
  const example = command.examples?.[0]
  return example || `${cliName} ${path.join(" ")}${outputFormat(command.output, false) === "json" ? " --json" : ""}`
}

function toolInputExample(cliName: string, path: string[], command: AgentCapabilityCliCommand): string {
  const example = firstExample(cliName, path, command)
  return example.startsWith(`${cliName} `) ? example.slice(cliName.length + 1) : example
}

export function renderCapabilityCliInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  capabilityId: string,
  cli: AgentCapabilityCliContribution<TRuntimeConfig, Name>,
): string {
  const leaves = commandLeaves(cli)
  return [
    `## Capability CLI: ${cli.name}`,
    "",
    cli.description || `Use the \`${cli.name}\` CLI for Capability "${capabilityId}".`,
    "",
    `Use \`${cli.name}\` commands for this capability instead of generic Bash or shell commands.`,
    "",
    "Available commands:",
    ...leaves.map(({ command, path }) => {
      const effects = command.effects?.length ? ` Effects: ${command.effects.join(", ")}.` : ""
      return `- \`${firstExample(cli.name, path, command)}\` - ${command.description || path.join(" ")}.${effects}`
    }),
  ].join("\n")
}

function nodeHelp<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  cli: AgentCapabilityCliContribution<TRuntimeConfig, Name>,
  path: string[] = [],
): string {
  let node: CliNode<TRuntimeConfig, Name> = cli
  for (const part of path) {
    const child = childCommands(node)?.[part]
    if (!child) break
    node = child
  }
  const children = childCommands(node)
  if (!children) {
    const command = node as AgentCapabilityCliCommand<TRuntimeConfig, Name>
    return [
      `Usage: ${cli.name} ${path.join(" ")} [--json] [--input <json>]`,
      "",
      command.description || "",
    ].filter(Boolean).join("\n")
  }
  return [
    `Usage: ${cli.name}${path.length ? ` ${path.join(" ")}` : ""} <command> [--json]`,
    "",
    "Available commands:",
    ...Object.entries(children).map(([name, command]) => `  ${name.padEnd(18)} ${command.description || ""}`.trimEnd()),
    "",
  ].join("\n")
}

function parseInputFlag(value: string): unknown {
  try {
    return JSON.parse(value)
  }
  catch {
    throw new Error("--input must be valid JSON.")
  }
}

function parseFlags(argv: string[], explicitInput: unknown, explicitJson: boolean | undefined): { input?: unknown, json: boolean } {
  let input = explicitInput
  let json = explicitJson === true
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg === "--input") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("Missing value for --input.")
      input = parseInputFlag(value)
      index += 1
      continue
    }
    if (arg.startsWith("--input=")) {
      input = parseInputFlag(arg.slice("--input=".length))
      continue
    }
    throw new Error(`Unknown Capability CLI option: ${arg}.`)
  }
  return { ...(input !== undefined ? { input } : {}), json }
}

function isHelpFlag(value: string | undefined): boolean {
  return value === "-h" || value === "--help"
}

function resolveCommand<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  cli: AgentCapabilityCliContribution<TRuntimeConfig, Name>,
  execution: AgentCapabilityCliExecutionInput,
): ResolvedCliCommand<TRuntimeConfig, Name> | { help: string, json: boolean, path: string[] } {
  const argv = [...(execution.argv || [])]
  let node: CliNode<TRuntimeConfig, Name> = cli
  const path: string[] = []
  let index = 0
  for (; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (isHelpFlag(arg)) {
      return { help: nodeHelp(cli, path), json: execution.json === true, path }
    }
    if (arg.startsWith("-")) break
    const child = childCommands(node)?.[arg]
    if (!child) throw new Error(`Unknown ${cli.name} command: ${[...path, arg].join(" ")}.`)
    node = child
    path.push(arg)
    if (isLeaf(child)) {
      index += 1
      break
    }
  }
  if (!isLeaf(node as AgentCapabilityCliCommand<TRuntimeConfig, Name>)) {
    throw new Error(`Missing ${cli.name} subcommand. Run \`${cli.name}${path.length ? ` ${path.join(" ")}` : ""} --help\`.`)
  }
  if (argv.slice(index).some(isHelpFlag)) {
    return { help: nodeHelp(cli, path), json: execution.json === true, path }
  }
  return {
    argv,
    command: node as LeafCliCommand<TRuntimeConfig, Name>,
    path,
    ...parseFlags(argv.slice(index), execution.input, execution.json),
  }
}

function outputSchema(output: AgentCapabilityCliCommand["output"]): AgentCapabilityCliStandardSchemaV1 | undefined {
  if (isStandardSchema(output)) return output
  return isRecord(output) && isStandardSchema(output.schema) ? output.schema : undefined
}

function outputFormat(output: AgentCapabilityCliCommand["output"], json: boolean): AgentCapabilityCliOutputFormat {
  if (json) return "json"
  if (isRecord(output) && output.format === "text") return "text"
  return "json"
}

function outputStdout(output: unknown, format: AgentCapabilityCliOutputFormat): { json?: unknown, stdout: string } {
  if (format === "text") {
    return { stdout: output === undefined ? "" : `${typeof output === "string" ? output : JSON.stringify(output)}\n` }
  }
  return {
    json: output,
    stdout: `${JSON.stringify(output ?? null, null, 2)}\n`,
  }
}

function result(
  capabilityId: string,
  cliName: string,
  argv: string[],
  startedAt: number,
  output: { json?: unknown, stdout: string },
): AgentCapabilityCliExecutionResult {
  return {
    argv,
    capability: capabilityId,
    cli: cliName,
    command: [cliName, ...argv].join(" "),
    durationMs: Date.now() - startedAt,
    exitCode: 0,
    ...(output.json !== undefined ? { json: output.json } : {}),
    outputTruncated: false,
    stderr: "",
    stdout: output.stdout,
  }
}

export async function runCapabilityCliCommand<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  capabilityId: string,
  cli: AgentCapabilityCliContribution<TRuntimeConfig, Name>,
  execution: AgentCapabilityCliExecutionInput,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
): Promise<AgentCapabilityCliExecutionResult> {
  const startedAt = Date.now()
  const resolved = resolveCommand(cli, execution)
  if ("help" in resolved) {
    return result(capabilityId, cli.name, [...(execution.argv || [])], startedAt, { stdout: `${resolved.help.trimEnd()}\n` })
  }
  const input = resolved.command.input
    ? await parseStandardSchema(resolved.command.input, resolved.input, `${cli.name} ${resolved.path.join(" ")} input`)
    : resolved.input
  const rawOutput = await resolved.command.run({
    argv: resolved.argv,
    context,
    input,
    json: resolved.json,
  })
  const schema = outputSchema(resolved.command.output)
  const output = schema
    ? await parseStandardSchema(schema, rawOutput, `${cli.name} ${resolved.path.join(" ")} output`)
    : rawOutput
  return result(capabilityId, cli.name, resolved.argv, startedAt, outputStdout(output, outputFormat(resolved.command.output, resolved.json)))
}

export function createCapabilityCliTool<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  capability: AgentCapabilityDefinition<TRuntimeConfig, Name>,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
  cli: AgentCapabilityCliContribution<TRuntimeConfig, Name>,
): AgentToolSet | undefined {
  return {
    [cli.name]: defineInternalTool<AgentCapabilityCliExecutionInput, AgentCapabilityCliExecutionResult>({
      description: `Run the ${cli.name} Capability CLI. Use argv for subcommands, for example: ${commandLeaves(cli).map(({ command, path }) => `\`${toolInputExample(cli.name, path, command)}\``).join(", ")}.`,
      inputSchema: {
        additionalProperties: false,
        properties: {
          argv: { items: { type: "string" }, type: "array" },
          input: {},
          json: { type: "boolean" },
        },
        required: ["argv"],
        type: "object",
      },
      metadata: {
        capabilityId: capability.id,
        cli: cli.name,
        vitehubCapabilityCli: true,
      },
      name: cli.name,
      async execute(input) {
        return await runCapabilityCliCommand(capability.id, cli, input || {}, context)
      },
    }) as AgentToolDefinition,
  }
}
