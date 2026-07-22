import { normalizeSafeWorkspacePath } from "./core/path.ts"
import { appendWorkspaceFile, copyWorkspacePath } from "./fs-ops.ts"
import { loadWorkspaceShellModule } from "./runtime/dependency-loaders.ts"
import { getWorkspaceSourceRequestExecution } from "./sources/request-execution.ts"

import type { Workspace, WorkspaceAssets, WorkspaceMaterializeSourcesResult, WriteFileOptions } from "./core/types.ts"
import type { JSONSchema7, Schema, Tool, ToolSet } from "ai"

export type { WorkspaceMaterializeSourcesResult } from "./core/types.ts"

type ShellObservationEvent =
  | "command_finished"
  | "command_timed_out"
  | "policy_denied"
  | "session_disposed"

interface ShellRuntimeExecOptions {
  cwd?: string
  env?: Record<string, string>
  onStderr?: (chunk: string) => void
  onStdout?: (chunk: string) => void
  stdin?: string
  timeout?: number
  workspacePaths?: string[]
}

interface ShellObservation {
  command?: string
  cwd?: string
  durationMs?: number
  event: ShellObservationEvent
  exitCode: number | null
  maxOutputLength?: number
  outputTruncated?: boolean
  stderr: string
  stdout: string
  timedOut?: boolean
  workspaceGuardrail?: {
    kind: "broad_search" | "missing_path" | "no_match" | "timeout"
    path?: string
  }
}

interface ShellAnalyzeOptions {
  maxInputBytes?: number
  timeoutMs?: number
}

interface ShellAnalyzeResult {
  commands?: string[]
  error?: string
  hasCommandSubstitution?: boolean
  hasHeredocs?: boolean
  hasPipelines?: boolean
  hasRedirects?: boolean
  ok: boolean
  parser: "sh-syntax"
}

interface ShellProcess {
  id: string
  command: string
  cwd?: string
  stop(): Promise<ShellObservation>
}

interface ShellBoundary {
  cwd: boolean
  env: boolean
  filesystem: {
    mountPoint?: string
    writable: boolean
  }
  network: boolean | "unknown"
  processes: {
    background: boolean
    interactive: boolean
  }
  streaming: boolean
  timeout: {
    enforcedBy: "provider" | "runtime" | "unsupported"
    supported: boolean
  }
}

interface ShellExecutionProvider {
  analyze?: (command: string, options?: ShellAnalyzeOptions) => Promise<ShellAnalyzeResult>
  boundary: ShellBoundary
  exec(command: string, options?: ShellRuntimeExecOptions): Promise<ShellObservation>
  startProcess?: (command: string, options?: ShellRuntimeExecOptions) => Promise<ShellProcess>
}

interface ShellSessionPolicy {
  maxOutputLength?: number
  maxShellCalls?: number
  timeout?: number
}

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
  executionProvider?: ShellExecutionProvider | (() => MaybePromise<ShellExecutionProvider | undefined>)
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

type WorkspaceShellModule = typeof import("@vite-hub/shell/workspace")

type ValidationResult<T> =
  | { success: true, value: T }
  | { error: Error, success: false }

type JsonSchemaInput = JSONSchema7 | (() => JSONSchema7)
type MaybePromise<T> = T | Promise<T>
type WorkspaceSessionStarter = Pick<Workspace, "startSession">

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

function getWorkspaceSessionStarter(input: Workspace | WorkspaceAssets): WorkspaceSessionStarter | undefined {
  return typeof (input as Partial<WorkspaceSessionStarter>).startSession === "function"
    ? input as WorkspaceSessionStarter
    : undefined
}

function createWorkspaceSessionShellProvider(starter: WorkspaceSessionStarter): ShellExecutionProvider {
  return {
    boundary: {
      cwd: true,
      env: true,
      filesystem: {
        mountPoint: workspaceMountPoint,
        writable: true,
      },
      network: "unknown",
      processes: {
        background: false,
        interactive: false,
      },
      streaming: false,
      timeout: {
        enforcedBy: "provider",
        supported: true,
      },
    },
    async exec(command: string, execOptions: ShellRuntimeExecOptions = {}) {
      const session = await starter.startSession({ paths: execOptions.workspacePaths })
      let observation: ShellObservation
      try {
        const result = await session.exec("sh", ["-lc", command], {
          cwd: execOptions.cwd || workspaceMountPoint,
          env: execOptions.env,
          timeout: execOptions.timeout,
        })
        execOptions.onStdout?.(result.stdout)
        execOptions.onStderr?.(result.stderr)
        const timedOut = result.exitCode === 124 && /timed out/i.test(result.stderr)
        observation = {
          command,
          cwd: execOptions.cwd,
          event: timedOut ? "command_timed_out" : "command_finished",
          exitCode: result.exitCode,
          stderr: result.stderr,
          stdout: result.stdout,
          timedOut,
        } satisfies ShellObservation
      }
      catch (error) {
        try {
          await session.close()
        }
        catch (closeError) {
          throw new AggregateError([error, closeError], "[vitehub] Workspace shell execution failed and session cleanup also failed.")
        }
        throw error
      }
      await session.close()
      return observation
    },
  }
}

async function resolveExecutionProvider(
  provider: WorkspaceToolOptions["executionProvider"],
): Promise<ShellExecutionProvider | undefined> {
  return typeof provider === "function" ? await provider() : provider
}

function isUnavailableWorkspaceSession(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("Workspace exec requires an executable runtime")
    || message.includes("Workspace exec requires a Box session host")
    || (message.includes("Workspace") && message.includes("is not registered"))
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

function describeShellCommands(commands: string[], options: { sourceRequests?: boolean } = {}) {
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
    options.sourceRequests && "controlled `curl` for API-backed Sources listed under `.vitehub/sources/*.json`",
  ].filter(Boolean)
  const examples = [
    supported.has("rg") && supported.has("head") && "`rg 'siff|PLC' ingestion forecasting-engine | head -n 20`",
    supported.has("rg") && !supported.has("head") && "`rg 'siff|PLC' ingestion forecasting-engine`",
    supported.has("find") && "`find ingestion -type f -name '*.sql'`",
    supported.has("cat") && supported.has("head") && "`cat forecasting-engine/README.md | head -n 40`",
    options.sourceRequests && "`curl --json '{\"region\":\"eu\"}' https://example.com/api/source`",
  ].filter(Boolean)

  return [
    "Inspect files in `/workspace` with a Bash-compatible shell.",
    `Use these commands: ${available.join(", ")}.`,
    options.sourceRequests && "For controlled `curl`, inspect the matching `.vitehub/sources/<sourceKey>.json` descriptor first; ViteHub validates the request against the Source Request Shape and injects Source credentials.",
    "Pipes, redirects, chaining, quoted patterns, and multiline scripts are supported.",
    "Skip unsupported helpers such as `xargs`, `awk`, `sed`, `sort`, `cut`, or `python`.",
    "Answer conversational messages directly; do not use shell commands such as `echo` to compose replies.",
    examples.length && `Examples: ${examples.join("; ")}.`,
  ].filter(Boolean).join(" ")
}

async function runShellCommand(
  input: Workspace | WorkspaceAssets,
  command: string,
  options: { broadSearchPaths: string[], commands: string[], cwd: string, executionProvider?: WorkspaceToolOptions["executionProvider"], maxOutputLength: number, timeout?: number },
): Promise<WorkspaceShellResult> {
  const networkGrants = getWorkspaceSourceRequestExecution(input)
  const { createReadonlyWorkspaceFs, runWorkspaceInspectionCommand } = await loadWorkspaceShellModule() as WorkspaceShellModule
  const inspectionOptions = {
    broadSearchPaths: options.broadSearchPaths,
    commands: networkGrants ? [...options.commands, "curl"] : options.commands,
    cwd: options.cwd,
    fs: createReadonlyWorkspaceFs(input),
    maxOutputLength: options.maxOutputLength,
    networkGrants,
    timeout: options.timeout,
  }
  const starter = getWorkspaceSessionStarter(input)
  if (starter) {
    try {
      return await runWorkspaceInspectionCommand(input, command, {
        ...inspectionOptions,
        provider: createWorkspaceSessionShellProvider(starter),
      })
    }
    catch (error) {
      if (!isUnavailableWorkspaceSession(error)) throw error
    }
  }
  const provider = await resolveExecutionProvider(options.executionProvider)
  return await runWorkspaceInspectionCommand(input, command, {
    ...inspectionOptions,
    ...(provider ? { provider } : {}),
  })
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
    executionProvider: options.executionProvider,
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
    throw new TypeError("[vitehub] Write operations require a mutable Workspace. A useWorkspace(name, { mode: \"write\" }).tools.write() call provides one.")
  }

  const result: Record<string, Tool<any, any>> = {}

  if (resolved.commands.length) {
    result.shell = tool({
      description: describeShellCommands(resolved.commands, {
        sourceRequests: Boolean(getWorkspaceSourceRequestExecution(input)),
      }),
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
            stderr: `[vitehub] Workspace shell command budget exhausted after ${resolved.maxShellCalls} calls. The Workspace Tools shell call budget is exhausted for this run.\n`,
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
