import { normalizeSafeWorkspacePath } from "./core/path.ts"
import { appendWorkspaceFile, copyWorkspacePath } from "./fs-ops.ts"
import { getWorkspaceSourceRequestExecution } from "./sources/request-execution.ts"

import type { Workspace, WorkspaceAssets, WorkspaceMaterializeSourcesResult, WriteFileOptions } from "./core/types.ts"
import type { ShellObservation, ShellSessionPolicy } from "@vite-hub/shell"
import type { JSONSchema7, Schema, Tool, ToolSet } from "ai"

export type { WorkspaceMaterializeSourcesResult } from "./core/types.ts"

export type WorkspaceShellResult = ShellObservation

export interface WorkspacePathResult {
  path: string
}

export interface WorkspaceMoveResult {
  from: string
  to: string
}

export interface WorkspaceReadOperations {
  list?: boolean
  materialize?: boolean
  read?: boolean
  search?: boolean
}

export interface WorkspaceWriteOperations {
  appendFile?: boolean
  copyPath?: boolean
  deletePath?: boolean
  makeDir?: boolean
  movePath?: boolean
  writeFile?: boolean
}

export type WorkspaceToolOperations = WorkspaceReadOperations & {
  write?: true | WorkspaceWriteOperations
}

export interface WorkspaceToolOptions<Operations extends WorkspaceToolOperations | undefined = undefined> extends Pick<ShellSessionPolicy, "maxOutputLength" | "maxShellCalls" | "timeout"> {
  broadSearchPaths?: string[]
  cwd?: string
  operations?: Operations
}

export type EnabledReadCapability<Operations, Key extends keyof WorkspaceReadOperations> = Operations extends Record<Key, infer Value>
  ? Value extends false ? false : true
  : true

export type ShellEnabled<Operations> = true extends
  | EnabledReadCapability<Operations, "list">
  | EnabledReadCapability<Operations, "read">
  | EnabledReadCapability<Operations, "search">
  ? true
  : false

type ResolvedWriteOperations<Operations> = Operations extends { write: infer Write } ? Write : false

export type WorkspaceWriteToolMap = {
  appendFile: Tool<{ content: string, path: string }, WorkspacePathResult>
  copyPath: Tool<{ from: string, overwrite?: boolean, to: string }, WorkspaceMoveResult>
  deletePath: Tool<{ force?: boolean, path: string, recursive?: boolean }, WorkspacePathResult>
  makeDir: Tool<{ path: string, recursive?: boolean }, WorkspacePathResult>
  movePath: Tool<{ from: string, overwrite?: boolean, to: string }, WorkspaceMoveResult>
  writeFile: Tool<{ content: string, mediaType?: string, path: string }, WorkspacePathResult>
}

type EnabledWriteTools<Selection> = Selection extends true
  ? WorkspaceWriteToolMap
  : Selection extends WorkspaceWriteOperations
    ? {
        [Key in keyof WorkspaceWriteToolMap as Key extends keyof Selection
          ? Selection[Key] extends true ? Key : never
          : never]: WorkspaceWriteToolMap[Key]
      }
    : {}

export type WorkspaceTools<Operations = undefined> = ((ShellEnabled<Operations> extends true
  ? { shell: Tool<{ command: string }, WorkspaceShellResult> }
  : {}) & EnabledWriteTools<ResolvedWriteOperations<Operations>>
  & (Operations extends { materialize: true }
    ? { materialize_sources: Tool<{ path?: string, sources?: string[] }, WorkspaceMaterializeSourcesResult> }
    : {})
  ) & ToolSet

const defaultMaxOutputLength = 30_000
const workspaceMountPoint = "/workspace"
const aiSchemaSymbol = Symbol.for("vercel.ai.schema")

type ValidationResult<T> =
  | { success: true, value: T }
  | { error: Error, success: false }

type JsonSchemaInput = JSONSchema7 | (() => JSONSchema7)

function jsonSchema<T = unknown>(
  schema: JsonSchemaInput,
  { validate }: { validate?: (value: unknown) => PromiseLike<ValidationResult<T>> | ValidationResult<T> } = {},
): Schema<T> {
  let resolved = schema
  return {
    [aiSchemaSymbol]: true,
    _type: undefined,
    get jsonSchema() {
      if (typeof resolved === "function") resolved = resolved()
      return resolved
    },
    validate,
  } as unknown as Schema<T>
}

function tool<T extends Tool<any, any>>(definition: T): T {
  return definition
}

function isWorkspace(input: Workspace | WorkspaceAssets): input is Workspace {
  return "sync" in input
}

function cleanWorkspaceShellPath(path: string) {
  return normalizeSafeWorkspacePath(path.replace(/^\/workspace(?:\/|$)/, ""), { allowEmpty: true })
}

function cleanMutationPath(path: string) {
  const normalized = cleanWorkspaceShellPath(path)
  if (!normalized) throw new Error("[vitehub] Workspace root is not a valid mutation target.")
  return normalized
}

function resolveReadOperations(operations: WorkspaceReadOperations | WorkspaceToolOperations | undefined) {
  return {
    list: operations?.list !== false,
    materialize: operations?.materialize === true,
    read: operations?.read !== false,
    search: operations?.search !== false,
  }
}

function resolveWriteOperations(write: true | WorkspaceWriteOperations | undefined) {
  if (write === true) {
    return {
      appendFile: true,
      copyPath: true,
      deletePath: true,
      makeDir: true,
      movePath: true,
      writeFile: true,
    }
  }

  return {
    appendFile: write?.appendFile === true,
    copyPath: write?.copyPath === true,
    deletePath: write?.deletePath === true,
    makeDir: write?.makeDir === true,
    movePath: write?.movePath === true,
    writeFile: write?.writeFile === true,
  }
}

function shellCommandsFor(operations: ReturnType<typeof resolveReadOperations>) {
  const commands: string[] = []
  if (operations.list) commands.push("pwd", "ls", "find")
  if (operations.read) commands.push("cat", "head", "tail", "wc")
  if (operations.search) commands.push("grep", "rg")
  return commands
}

function describeShellCommands(commands: string[]) {
  const supported = new Set(commands)
  const available = [
    supported.has("pwd") && "`pwd`",
    supported.has("ls") && "`ls`",
    supported.has("find") && "`find`",
    (supported.has("rg") || supported.has("grep")) && "`rg [-i] pattern [path...]`, `grep -ri pattern [path...]`",
    supported.has("cat") && "`cat`",
    supported.has("head") && "`head`",
    supported.has("tail") && "`tail`",
    supported.has("wc") && "`wc`",
  ].filter(Boolean)
  const examples = [
    supported.has("rg") && supported.has("head") && "`rg 'siff|PLC' ingestion forecasting-engine | head -n 20`",
    supported.has("rg") && !supported.has("head") && "`rg 'siff|PLC' ingestion forecasting-engine`",
    supported.has("find") && "`find ingestion -type f -name '*.sql'`",
    supported.has("cat") && supported.has("head") && "`cat forecasting-engine/README.md | head -n 40`",
  ].filter(Boolean)

  return [
    "Inspect files in `/workspace` with a Bash-compatible shell.",
    `Use these commands: ${available.join(", ")}.`,
    "Pipes, redirects, chaining, quoted patterns, and multiline scripts are supported.",
    "Skip unsupported helpers such as `xargs`, `awk`, `sed`, `sort`, `cut`, or `python`.",
    "Answer conversational messages directly; do not use shell commands such as `echo` to compose replies.",
    examples.length && `Examples: ${examples.join("; ")}.`,
  ].filter(Boolean).join(" ")
}

async function runShellCommand(
  input: Workspace | WorkspaceAssets,
  command: string,
  options: { broadSearchPaths: string[], commands: string[], cwd: string, maxOutputLength: number, timeout?: number },
): Promise<WorkspaceShellResult> {
  const curlResult = await runSourceCurlCommand(input, command, options)
  if (curlResult) return curlResult

  const { createReadonlyWorkspaceFs, runWorkspaceInspectionCommand } = await import("@vite-hub/shell/workspace")
  return await runWorkspaceInspectionCommand(input, command, {
    broadSearchPaths: options.broadSearchPaths,
    commands: options.commands,
    cwd: options.cwd,
    fs: createReadonlyWorkspaceFs(input),
    maxOutputLength: options.maxOutputLength,
    timeout: options.timeout,
  })
}

async function runSourceCurlCommand(
  input: Workspace | WorkspaceAssets,
  command: string,
  options: { cwd: string, maxOutputLength: number, timeout?: number },
): Promise<WorkspaceShellResult | undefined> {
  if (!mentionsCurlCommand(command)) return undefined

  const parsed = parseControlledCurlCommand(command)
  if (!parsed.ok) return policyDeniedCurl(command, options.cwd, parsed.error)

  const executor = getWorkspaceSourceRequestExecution(input)
  if (!executor) {
    return policyDeniedCurl(command, options.cwd, "No API-backed Source request descriptors are visible in this workspace.")
  }

  const started = Date.now()
  try {
    const result = await executor.executeSourceRequest({
      body: parsed.body,
      method: parsed.method,
      url: parsed.url,
    })
    const stdout = typeof result.content === "string" ? result.content : new TextDecoder().decode(result.content)
    const limited = limitShellOutput(stdout, options.maxOutputLength)
    return {
      command,
      cwd: options.cwd,
      durationMs: Date.now() - started,
      event: "command_finished",
      exitCode: 0,
      maxOutputLength: options.maxOutputLength,
      outputTruncated: limited.truncated,
      stderr: "",
      stdout: limited.output,
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const httpFailure = message.includes("HTTP request failed")
    return {
      command,
      cwd: options.cwd,
      durationMs: Date.now() - started,
      event: httpFailure ? "command_finished" : "policy_denied",
      exitCode: httpFailure ? 22 : 126,
      stderr: `${message}\n`,
      stdout: "",
    }
  }
}

type ParsedControlledCurl =
  | { body?: unknown, method: "GET" | "HEAD" | "POST", ok: true, url: string }
  | { error: string, ok: false }

function parseControlledCurlCommand(command: string): ParsedControlledCurl {
  if (hasUnsupportedCurlShellSyntax(command)) {
    return { error: "Controlled curl must be a single command without pipes, redirects, chaining, command substitution, or heredocs.", ok: false }
  }

  let words: string[]
  try {
    words = parseShellWords(command)
  }
  catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false }
  }

  if (words[0] !== "curl") return { error: "Controlled curl command must start with curl.", ok: false }

  let body: unknown
  let method: "GET" | "HEAD" | "POST" | undefined
  let url: string | undefined

  try {
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index]!
      if (word === "-s" || word === "-S" || word === "-sS" || word === "--silent" || word === "--show-error" || word === "-L" || word === "--location") {
        continue
      }
      if (word === "-X" || word === "--request") {
        const value = words[++index]
        if (!value) return { error: `${word} requires a method.`, ok: false }
        method = parseCurlMethod(value)
        if (!method) return { error: `Unsupported curl request method: ${value}.`, ok: false }
        continue
      }
      if (word.startsWith("--request=")) {
        method = parseCurlMethod(word.slice("--request=".length))
        if (!method) return { error: `Unsupported curl request method: ${word.slice("--request=".length)}.`, ok: false }
        continue
      }
      if (word === "--url") {
        const value = words[++index]
        if (!value) return { error: "--url requires a URL.", ok: false }
        url = setCurlUrl(url, value)
        continue
      }
      if (word.startsWith("--url=")) {
        url = setCurlUrl(url, word.slice("--url=".length))
        continue
      }
      if (word === "--json") {
        const value = words[++index]
        if (!value) return { error: "--json requires a JSON body.", ok: false }
        const parsed = parseJsonCurlBody(value)
        if (!parsed.ok) return parsed
        body = parsed.body
        method ??= "POST"
        continue
      }
      if (word.startsWith("--json=")) {
        const parsed = parseJsonCurlBody(word.slice("--json=".length))
        if (!parsed.ok) return parsed
        body = parsed.body
        method ??= "POST"
        continue
      }
      if (word === "-d" || word === "--data" || word === "--data-raw" || word === "--data-binary" || word.startsWith("-d") || word.startsWith("--data=") || word.startsWith("--data-raw=") || word.startsWith("--data-binary=")) {
        return { error: "Controlled curl v1 does not allow -d/--data flags. Use --json with a declared bodySchema.", ok: false }
      }
      if (word === "-H" || word === "--header" || word === "-b" || word === "--cookie" || word.startsWith("--header=") || word.startsWith("--cookie=")) {
        return { error: "Controlled curl injects Source credentials itself; do not pass headers or cookies in the command.", ok: false }
      }
      if (word.startsWith("-")) return { error: `Unsupported curl flag: ${word}.`, ok: false }
      url = setCurlUrl(url, word)
    }
  }
  catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false }
  }

  if (!url) return { error: "Controlled curl requires a URL.", ok: false }
  try {
    url = new URL(url).toString()
  }
  catch {
    return { error: `Controlled curl URL is invalid: ${url}.`, ok: false }
  }

  return {
    body,
    method: method ?? "GET",
    ok: true,
    url,
  }
}

function mentionsCurlCommand(command: string): boolean {
  return parseShellWordsLenient(command)[0] === "curl"
}

function hasUnsupportedCurlShellSyntax(command: string): boolean {
  let quote: "'" | "\"" | undefined
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    const next = command[index + 1]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      continue
    }
    if (char === "|" || char === ";" || char === "<" || char === ">" || char === "`" || char === "$" && next === "(") return true
    if ((char === "&" || char === "|") && next === char) return true
  }
  return /<<-?/.test(command)
}

function parseShellWordsLenient(command: string): string[] {
  try {
    return parseShellWords(command)
  }
  catch {
    return command.trim().split(/\s+/).filter(Boolean)
  }
}

function parseShellWords(command: string): string[] {
  const words: string[] = []
  let current = ""
  let quote: "'" | "\"" | undefined
  let escaped = false

  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ""
      }
      continue
    }
    current += char
  }

  if (escaped) current += "\\"
  if (quote) throw new Error("unterminated quote")
  if (current) words.push(current)
  return words
}

function parseCurlMethod(value: string): "GET" | "HEAD" | "POST" | undefined {
  const method = value.toUpperCase()
  return method === "GET" || method === "HEAD" || method === "POST" ? method : undefined
}

function parseJsonCurlBody(value: string): { body: unknown, ok: true } | { error: string, ok: false } {
  try {
    return { body: JSON.parse(value), ok: true }
  }
  catch {
    return { error: "--json body must be valid JSON.", ok: false }
  }
}

function setCurlUrl(current: string | undefined, next: string): string {
  if (current) throw new Error("Controlled curl accepts exactly one URL.")
  return next
}

function policyDeniedCurl(command: string, cwd: string, message: string): WorkspaceShellResult {
  return {
    command,
    cwd,
    event: "policy_denied",
    exitCode: 126,
    stderr: `[vitehub] ${message}\n`,
    stdout: [
      "[vitehub] Controlled curl request was not run.",
      "Inspect `.vitehub/sources/<sourceKey>.json`, then retry with a single curl command that matches a visible Source request descriptor.",
    ].join("\n") + "\n",
  }
}

function limitShellOutput(output: string, maxOutputLength: number): { output: string, truncated?: boolean } {
  if (output.length <= maxOutputLength) return { output }
  return {
    output: `${output.slice(0, maxOutputLength)}\n[output truncated to ${maxOutputLength} characters]\n`,
    truncated: true,
  }
}

function sizeOf(content: string | Uint8Array) {
  return typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength
}

async function materializeWorkspaceSourcesTool(
  input: Workspace | WorkspaceAssets,
  options: { path?: string, sources?: string[] },
): Promise<WorkspaceMaterializeSourcesResult> {
  if ("materializeSources" in input && typeof input.materializeSources === "function") {
    return await input.materializeSources(options)
  }

  const started = Date.now()
  const path = cleanWorkspaceShellPath(options.path || "") || ""
  const entries = await input.list(path, { recursive: true })
  let bytes = 0
  let directories = 0
  let files = 0

  for (const entry of entries) {
    if (entry.type === "directory") {
      directories++
      continue
    }
    const content = await input.readFile(entry.path, { encoding: "binary" })
    bytes += sizeOf(content)
    files++
  }

  return {
    bytes,
    directories,
    durationMs: Date.now() - started,
    files,
    path,
    sources: [],
  }
}

function createWriteTools(workspace: Workspace, enabled: ReturnType<typeof resolveWriteOperations>): Partial<WorkspaceWriteToolMap> {
  const result: Partial<WorkspaceWriteToolMap> = {}

  if (enabled.writeFile) {
    result.writeFile = tool({
      description: "Write a text file to the workspace.",
      inputSchema: jsonSchema<{ content: string, mediaType?: string, path: string }>({
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          mediaType: { type: "string" },
          path: { type: "string" },
        },
        required: ["path", "content"],
        type: "object",
      }),
      execute: async ({ content, mediaType, path }) => {
        const normalized = cleanMutationPath(path)
        await workspace.writeFile(normalized, content, { mediaType } satisfies WriteFileOptions)
        return { path: normalized }
      },
    })
  }

  if (enabled.appendFile) {
    result.appendFile = tool({
      description: "Append text to a workspace file, creating it if it does not exist.",
      inputSchema: jsonSchema<{ content: string, path: string }>({
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          path: { type: "string" },
        },
        required: ["path", "content"],
        type: "object",
      }),
      execute: async ({ content, path }) => {
        const normalized = cleanMutationPath(path)
        await appendWorkspaceFile(workspace, normalized, content)
        return { path: normalized }
      },
    })
  }

  if (enabled.deletePath) {
    result.deletePath = tool({
      description: "Delete a file or directory from the workspace.",
      inputSchema: jsonSchema<{ force?: boolean, path: string, recursive?: boolean }>({
        additionalProperties: false,
        properties: {
          force: { type: "boolean" },
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
        type: "object",
      }),
      execute: async ({ force, path, recursive }) => {
        const normalized = cleanMutationPath(path)
        await workspace.rm(normalized, { force, recursive })
        return { path: normalized }
      },
    })
  }

  if (enabled.makeDir) {
    result.makeDir = tool({
      description: "Create a directory in the workspace.",
      inputSchema: jsonSchema<{ path: string, recursive?: boolean }>({
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
        type: "object",
      }),
      execute: async ({ path, recursive }) => {
        const normalized = cleanMutationPath(path)
        await workspace.mkdir(normalized, { recursive })
        return { path: normalized }
      },
    })
  }

  if (enabled.copyPath) {
    result.copyPath = tool({
      description: "Copy a file or directory inside the workspace.",
      inputSchema: jsonSchema<{ from: string, overwrite?: boolean, to: string }>({
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          overwrite: { type: "boolean" },
          to: { type: "string" },
        },
        required: ["from", "to"],
        type: "object",
      }),
      execute: async ({ from, overwrite = false, to }) => {
        const source = cleanMutationPath(from)
        const target = cleanMutationPath(to)
        await copyWorkspacePath(workspace, source, target, overwrite)
        return { from: source, to: target }
      },
    })
  }

  if (enabled.movePath) {
    result.movePath = tool({
      description: "Move or rename a file or directory inside the workspace.",
      inputSchema: jsonSchema<{ from: string, overwrite?: boolean, to: string }>({
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          overwrite: { type: "boolean" },
          to: { type: "string" },
        },
        required: ["from", "to"],
        type: "object",
      }),
      execute: async ({ from, overwrite = false, to }) => {
        const source = cleanMutationPath(from)
        const target = cleanMutationPath(to)
        await copyWorkspacePath(workspace, source, target, overwrite)
        await workspace.rm(source, { recursive: true, force: true })
        return { from: source, to: target }
      },
    })
  }

  return result
}

export function createWorkspaceTools<Operations extends WorkspaceToolOperations | undefined = undefined>(
  input: Workspace | WorkspaceAssets,
  options: WorkspaceToolOptions<Operations> = {},
): WorkspaceTools<Operations> {
  const resolved = {
    broadSearchPaths: options.broadSearchPaths || [],
    commands: shellCommandsFor(resolveReadOperations(options.operations)),
    cwd: options.cwd || workspaceMountPoint,
    materialize: resolveReadOperations(options.operations).materialize,
    maxShellCalls: options.maxShellCalls,
    maxOutputLength: options.maxOutputLength || defaultMaxOutputLength,
    timeout: options.timeout,
    write: resolveWriteOperations(options.operations?.write),
  }
  let shellCalls = 0
  const writeEnabled = Object.values(resolved.write).some(Boolean)

  if (!resolved.commands.length && !resolved.materialize && !writeEnabled) {
    throw new TypeError("[vitehub] createWorkspaceTools requires at least one enabled workspace operation.")
  }

  if (writeEnabled && !isWorkspace(input)) {
    throw new TypeError("[vitehub] Write operations require a mutable Workspace. Use useWorkspace(name, { mode: \"write\" }).tools.write().")
  }

  const result: Record<string, Tool<any, any>> = {}

  if (resolved.commands.length) {
    result.shell = tool({
      description: describeShellCommands(resolved.commands),
      inputSchema: jsonSchema<{ command: string }>({
        additionalProperties: false,
        properties: {
          command: {
            description: "A Bash-compatible workspace shell command. Use pipes, redirects, chaining, and quoted patterns as needed.",
            type: "string",
          },
        },
        required: ["command"],
        type: "object",
      }),
      execute: async ({ command }) => {
        if (typeof resolved.maxShellCalls === "number" && shellCalls >= resolved.maxShellCalls) {
          return {
            command,
            cwd: resolved.cwd,
            event: "policy_denied",
            exitCode: 126,
            stderr: `[vitehub] Workspace shell command budget exhausted after ${resolved.maxShellCalls} calls. Answer from the evidence already collected instead of running more shell commands.\n`,
            stdout: "",
          } satisfies WorkspaceShellResult
        }
        shellCalls += 1
        return await runShellCommand(input, command, resolved)
      },
    })
  }

  if (resolved.materialize) {
    result.materialize_sources = tool({
      description: [
        "Materialize complete workspace source snapshots as an explicit tool step before shell inspection.",
        "This prepares whole sources, not individual files or partial limits.",
      ].join(" "),
      inputSchema: jsonSchema<{ path?: string, sources?: string[] }>({
        additionalProperties: false,
        properties: {
          path: {
            description: "Workspace path prefix to materialize. Defaults to the workspace root.",
            type: "string",
          },
          sources: {
            description: "Optional source names to materialize.",
            items: { type: "string" },
            type: "array",
          },
        },
        type: "object",
      }),
      execute: async ({ path, sources }) => await materializeWorkspaceSourcesTool(input, { path, sources }),
    })
  }

  if (writeEnabled) Object.assign(result, createWriteTools(input as Workspace, resolved.write))

  return result as WorkspaceTools<Operations>
}
