import { hasRuntimeType, isRuntimeRecord } from "./internal/runtime-type.ts"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { chmod, mkdir, mkdtemp, lstat, readFile, readlink, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join, relative, resolve } from "node:path"

import { getViteHubErrorShape, normalizeExecutionAuthority } from "@vite-hub/runtime"
import { resolveWorkspaceAutoCommit } from "@vite-hub/workspace"

import { hasTrustedWorkspaceAccessScope } from "./access-runtime.ts"
import { setActiveAgentWorkspaceCommands, setActiveAgentWorkspaceFiles, setAgentWorkspaceDiff } from "./agent-workspace-runtime.ts"
import { streamAgentOutputToEvents } from "./agent-output.ts"
import { composeInstructionDocument } from "./instruction-composition.ts"
import { agentInvocationCallbackContextValues } from "./invocation-context.ts"
import { colocatedAgentSkillsContextKey } from "./internal/colocated-agent-skills.ts"
import { defaultAgentProviderPermissions } from "./internal/agent-driver.ts"
import { updateAgentTelemetryConfiguration } from "./internal/agent-telemetry.ts"
import { agentOutputInstructions } from "./internal/agent-structured-output.ts"
import { agentInvocationControlId, registerAgentInvocationInputHandler } from "./internal/agent-invocation-control.ts"
import { isAuxiliaryAgentAdapterContext, resolveMessageChannelInstructions } from "./internal/channels.ts"
import { attachmentStringBytes, currentInputAttachments, getMessageText, resolveAttachmentData } from "./messages.ts"
import { workspaceDefinitionWithAutoCommitRules } from "./workspace-agent.ts"
import { agentToolPolicyApproveSymbol } from "./tool-runtime.ts"
import { createAgentStreamEventTracer } from "./trace.ts"

import type {
  ProviderApprovalDecision,
  ProviderRuntime,
  ProviderRuntimeEvent,
  ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/provider-runtime"
import type {
  AgentAdapter,
  AgentAdapterInstructions,
  AgentAdapterMetadataContext,
  AgentAdapterResult,
  AgentAdapterRunContext,
  AgentProviderPermissions,
  AgentRuntimeConfig,
  AgentToolDefinition,
  AgentToolSchema,
  AgentToolSet,
} from "./types.ts"
import type { AttachmentPart, Message, StreamEvent } from "./messages.ts"
import type {
  ReadonlyWorkspaceFacade,
  WorkspaceSession,
  WorkspaceSessionHost,
  WorkspaceSessionHostFileEntry,
  WorkspaceSessionOptions,
} from "@vite-hub/workspace"
import { agentProviderCleanupTask } from "./internal/provider-cleanup-task.ts"

export interface ProviderAgentAdapterOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  env?: Record<string, string | undefined>
  execution?: { attachments?: { maxBytes?: number } }
  instructions?: AgentAdapterInstructions<TRuntimeConfig>
  model?: string
  permissions?: AgentProviderPermissions
  provider: "claude-code" | "codex"
}

interface GeneratedProviderFile {
  content?: Uint8Array
  directories: string[]
  existed: boolean
  link?: string
  mode?: number
  path: string
}

async function materializeGeneratedProviderFile(root: string, path: string, content: string | Uint8Array): Promise<GeneratedProviderFile> {
  let parent = root
  const directories: string[] = []
  for (const segment of relative(root, dirname(path)).split(/[\\/]/).filter(Boolean)) {
    parent = join(parent, segment)
    const parentEntry = await lstat(parent).catch(() => undefined)
    if (parentEntry?.isSymbolicLink()) throw new Error(`[vitehub] Generated provider file parent must not be a symbolic link: ${parent}`)
    if (parentEntry && !parentEntry.isDirectory()) throw new Error(`[vitehub] Generated provider file parent must be a directory: ${parent}`)
    if (!parentEntry) directories.push(parent)
  }
  const entry = await lstat(path).catch(() => undefined)
  if (entry && !entry.isFile() && !entry.isSymbolicLink()) {
    throw new Error(`[vitehub] Generated provider file collides with a non-file entry: ${path}`)
  }
  const generated = {
    content: entry?.isFile() ? await readFile(path) : undefined,
    directories,
    existed: entry !== undefined,
    link: entry?.isSymbolicLink() ? await readlink(path) : undefined,
    mode: entry?.isFile() ? entry.mode : undefined,
    path,
  }
  try {
    if (entry?.isSymbolicLink()) await rm(path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    return generated
  }
  catch (error) {
    await restoreGeneratedProviderFile(generated)
    throw error
  }
}

async function restoreGeneratedProviderFile(generated: GeneratedProviderFile): Promise<void> {
  await rm(generated.path, { force: true, recursive: true })
  if (generated.link !== undefined) await symlink(generated.link, generated.path)
  else if (generated.existed) {
    await writeFile(generated.path, generated.content!)
    if (generated.mode !== undefined) await chmod(generated.path, generated.mode)
  }
  for (const directory of generated.directories.reverse()) {
    await rmdir(directory).catch((error) => {
      // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST" && code !== "ENOENT" && code !== "ENOTEMPTY") throw error
    })
  }
}

const imageExtensions: Record<string, string> = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
}

const providerRuntimeMode: Record<AgentProviderPermissions, RuntimeMode> = {
  "allow-all": "full-access",
  "allow-edits": "auto-accept-edits",
  ask: "approval-required",
}

const providerCleanupTimeoutMs = 10_000

// SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
const providerHostEnvironmentKeys = [
  "APPDATA",
  "ComSpec",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const

function providerEnvironment(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const host = Object.fromEntries(providerHostEnvironmentKeys.flatMap(key => hasRuntimeType(process.env[key], "string") ? [[key, process.env[key]]] : []))
  return Object.fromEntries(Object.entries({ ...host, ...env }).filter((entry): entry is [string, string] => hasRuntimeType(entry[1], "string")))
}

async function waitForProviderOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  disposeLateResult?: (value: T) => void | Promise<void>,
  observeLateCleanup?: (cleanup: Promise<void>) => void,
  disposeLateError?: () => void | Promise<void>,
): Promise<T> {
  if (signal?.aborted && disposeLateResult) {
    const cleanup = operation.then(disposeLateResult, disposeLateError)
    observeLateCleanup?.(cleanup)
    void cleanup.catch(() => undefined)
  }
  signal?.throwIfAborted()
  if (!signal) return await operation
  let rejectAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const abort = () => rejectAbort?.(signal.reason ?? new DOMException("[vitehub] Provider Agent Driver invocation aborted.", "AbortError"))
  signal.addEventListener("abort", abort, { once: true })
  try {
    return await Promise.race([operation, aborted])
  }
  catch (error) {
    if (signal.aborted && disposeLateResult) {
      const cleanup = operation.then(disposeLateResult, disposeLateError)
      observeLateCleanup?.(cleanup)
      void cleanup.catch(() => undefined)
    }
    throw error
  }
  finally {
    signal.removeEventListener("abort", abort)
  }
}

function createProviderCleanupSignal(invocationSignal: AbortSignal | undefined): { dispose: () => void, signal: AbortSignal } {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("[vitehub] Provider Agent Driver cleanup timed out.", "TimeoutError"))
  }, providerCleanupTimeoutMs)
  const abort = () => controller.abort(invocationSignal?.reason ?? new DOMException("[vitehub] Provider Agent Driver invocation aborted.", "AbortError"))
  if (invocationSignal?.aborted) abort()
  else invocationSignal?.addEventListener("abort", abort, { once: true })
  return {
    dispose() {
      clearTimeout(timeout)
      invocationSignal?.removeEventListener("abort", abort)
    },
    signal: controller.signal,
  }
}

function providerCleanupTimedOut(error: unknown): boolean {
  return error instanceof DOMException
    && error.name === "TimeoutError"
    && error.message === "[vitehub] Provider Agent Driver cleanup timed out."
}

async function removeProviderRoot(root: string): Promise<void> {
  if (dirname(root) !== tmpdir() || !basename(root).startsWith("vitehub-provider-")) {
    throw new Error(`[vitehub] Refusing to remove unexpected Provider Agent Driver root: ${root}`)
  }
  if (process.platform === "win32") return await rm(root, { force: true, recursive: true })
  await new Promise<void>((resolve, reject) => {
    const child = spawn("rm", ["-rf", "--", root], { stdio: "ignore" })
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    child.once("error", finish)
    child.once("close", (code, childSignal) => {
      if (code === 0) finish()
      else finish(new Error(`[vitehub] Provider Agent Driver root cleanup exited with ${childSignal ? `signal ${childSignal}` : `code ${code}`}.`))
    })
  })
}

async function acquireProviderSessionLock(locks: Map<string, Promise<void>>, key: string, signal?: AbortSignal): Promise<() => void> {
  const previous = locks.get(key) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => release = resolve)
  const tail = previous.then(() => current)
  locks.set(key, tail)
  const releaseLock = () => {
    release()
    if (locks.get(key) === tail) locks.delete(key)
  }
  try {
    await waitForProviderOperation(previous, signal)
  }
  catch (error) {
    void previous.then(releaseLock)
    throw error
  }
  return releaseLock
}

// SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
const emptyToolInputSchema = { additionalProperties: false, properties: {}, type: "object" } as const

function toolJsonSchema(schema: AgentToolSchema | undefined): Record<string, unknown> {
  if (!schema) return emptyToolInputSchema
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  if (!("~standard" in schema)) return schema as Record<string, unknown>
  const jsonSchema = schema["~standard"]?.jsonSchema
  if (!jsonSchema?.input) throw new Error("[vitehub] Provider Agent Driver tools require JSON Schema-compatible input validation.")
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  return jsonSchema.input({ target: "draft-07" }) as Record<string, unknown>
}

async function validateToolInput(tool: AgentToolDefinition, input: unknown): Promise<unknown> {
  if (!tool.inputSchema) return input
  if ("~standard" in tool.inputSchema) {
    const standard = tool.inputSchema["~standard"]
    if (!standard) throw new TypeError(`[vitehub] Invalid schema for Agent tool "${tool.name}".`)
    const result = await standard.validate(input)
    if (result.issues?.length) throw new TypeError(`[vitehub] Invalid input for Agent tool "${tool.name}".`)
    return "value" in result ? result.value : input
  }
  const { Validator } = await import("@cfworker/json-schema")
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  const result = new Validator(tool.inputSchema as never, "7").validate(input)
  if (!result.valid) throw new TypeError(`[vitehub] Invalid input for Agent tool "${tool.name}": ${result.errors.map(error => error.error).join("; ")}`)
  return input
}

async function validateToolInputUntilCanceled(tool: AgentToolDefinition, input: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  let cancel!: () => void
  const canceled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"))
    signal.addEventListener("abort", cancel, { once: true })
  })
  try {
    return await Promise.race([validateToolInput(tool, input), canceled])
  }
  finally {
    signal.removeEventListener("abort", cancel)
  }
}

function toolResult(value: unknown) {
  const text = hasRuntimeType(value, "string") ? value : JSON.stringify(value) ?? String(value)
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  return { content: [{ text, type: "text" as const }] }
}

async function startToolServer(
  tools: AgentToolSet,
  abortSignal: AbortSignal | undefined,
  emit: (event: StreamEvent) => void,
  approvals: Map<string, (approved: boolean) => boolean>,
  capabilityApprovalIds: Set<string>,
) {
  const [{ Server: McpServer }, { StreamableHTTPServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ])
  const token = crypto.randomUUID()
  const mcp = new McpServer({ name: "vitehub-agent", version: "1" }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, tool]) => ({
      description: tool.description,
      // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
      inputSchema: toolJsonSchema(tool.inputSchema) as never,
      name,
    })),
  }))
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools[request.params.name]
    if (!tool?.execute) return { content: [{ text: `Unknown Agent tool: ${request.params.name}`, type: "text" }], isError: true }
    const executionSignal = AbortSignal.any([extra.signal, ...(abortSignal ? [abortSignal] : [])])
    try {
      const input = await validateToolInputUntilCanceled(tool, request.params.arguments || {}, executionSignal)
      executionSignal.throwIfAborted()
      return toolResult(await tool.execute(input, { abortSignal: executionSignal }))
    }
    catch (error) {
      const shape = getViteHubErrorShape(error)
      const approvalRequest = shape?.code === "APPROVAL_REQUIRED" && error instanceof Error && error.cause && hasRuntimeType(error.cause, "object")
        // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
        ? error.cause as { capability?: unknown, id?: unknown, input?: unknown, reason?: unknown }
        : undefined
      if (approvalRequest && hasRuntimeType(approvalRequest.id, "string")) {
        capabilityApprovalIds.add(approvalRequest.id)
        emit({
          id: approvalRequest.id,
          input: approvalRequest.input,
          name: hasRuntimeType(approvalRequest.capability, "string") ? approvalRequest.capability : request.params.name,
          reason: hasRuntimeType(approvalRequest.reason, "string") ? approvalRequest.reason : undefined,
          type: "approval-request",
        })
        let abortApproval: (() => void) | undefined
        const approved = await new Promise<boolean>((resolve) => {
          abortApproval = () => resolve(false)
          // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
          approvals.set(approvalRequest.id as string, (approved) => {
            // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
            approvals.delete(approvalRequest.id as string)
            if (executionSignal.aborted) {
              resolve(false)
              return false
            }
            resolve(approved)
            return true
          })
          executionSignal.addEventListener("abort", abortApproval, { once: true })
          if (executionSignal.aborted) abortApproval()
        }).finally(() => {
          executionSignal.removeEventListener("abort", abortApproval!)
          // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
          approvals.delete(approvalRequest.id as string)
        })
        if (approved) {
          // Let an MCP cancellation already in transit settle before turning
          // the user's approval into a side effect.
          await new Promise<void>(resolve => setImmediate(resolve))
          executionSignal.throwIfAborted()
          // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
          const approve = (tool as AgentToolDefinition & { [agentToolPolicyApproveSymbol]?: (input: unknown) => void })[agentToolPolicyApproveSymbol]
          if (approve) {
            approve(approvalRequest.input)
            return toolResult(await tool.execute!(approvalRequest.input, { abortSignal: executionSignal }))
          }
        }
      }
      return { content: [{ text: error instanceof Error ? error.message : String(error), type: "text" }], isError: true }
    }
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() })
  await mcp.connect(transport)
  const http = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    void transport.handleRequest(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
  const address = http.address()
  if (!address || hasRuntimeType(address, "string")) throw new Error("[vitehub] Provider Agent Driver failed to start its Capability tool server.")
  return {
    async close() {
      http.closeAllConnections()
      await Promise.all([
        mcp.close(),
        new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())),
      ])
    },
    mcp: { authorizationHeader: `Bearer ${token}`, endpoint: `http://127.0.0.1:${address.port}/mcp` },
  }
}

export function localWorkspaceHost(): WorkspaceSessionHost {
  return {
    executionAuthority: normalizeExecutionAuthority({
      credentials: "ambient",
      environment: "ambient",
      filesystem: { access: "read-write", scope: "host" },
      isolation: "none",
      network: "unrestricted",
      processes: "arbitrary",
    }),
    files: {
      async exists(path, options) {
        options?.signal?.throwIfAborted()
        // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
        const exists = await lstat(path).then(() => true, error => (error as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(error))
        options?.signal?.throwIfAborted()
        return exists
      },
      async list(path, options) {
        options?.signal?.throwIfAborted()
        const entries: WorkspaceSessionHostFileEntry[] = []
        const excluded = options?.exclude?.map(item => resolve(item)) || []
        const isExcluded = (target: string) => excluded.some(item => target === item || target.startsWith(`${item}/`))
        const visit = async (directory: string) => {
          options?.signal?.throwIfAborted()
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            options?.signal?.throwIfAborted()
            const target = join(directory, entry.name)
            if (isExcluded(resolve(target))) continue
            const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file"
            const stats = type === "file" ? await lstat(target) : undefined
            entries.push({
              path: target,
              ...(stats ? { executable: Boolean(stats.mode & 0o100), size: stats.size } : {}),
              type,
            })
            if (options?.recursive && type === "directory") await visit(target)
          }
        }
        await visit(path)
        return entries
      },
      async mkdir(path, options) {
        options?.signal?.throwIfAborted()
        await mkdir(path, options)
        options?.signal?.throwIfAborted()
      },
      async read(path, options) {
        // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
        return await readFile(path, { signal: options?.signal }).then(value => new Uint8Array(value), error => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error))
      },
      async remove(path, options) {
        options?.signal?.throwIfAborted()
        await rm(path, { force: true, recursive: options?.recursive })
        options?.signal?.throwIfAborted()
      },
      async write(path, content, options) {
        options?.signal?.throwIfAborted()
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content, { signal: options?.signal })
      },
    },
    async exec(command, args = [], options = {}) {
      const cwd = resolve(options.cwd || process.cwd())
      const timeoutSignal = options.timeout ? AbortSignal.timeout(options.timeout) : undefined
      const signal = options.signal && timeoutSignal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : options.signal || timeoutSignal
      return await new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
          cwd,
          detached: true,
          env: {
            // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
            ...providerEnvironment(options.env as Record<string, string> | undefined),
            INIT_CWD: cwd,
            OLDPWD: cwd,
            PWD: cwd,
          },
          signal,
        })
        let stdout = ""
        let stderr = ""
        let executionError: unknown
        let forceKill: ReturnType<typeof setTimeout> | undefined
        let termination: Promise<void> | undefined
        const killProcessGroup = (killSignal: NodeJS.Signals) => {
          if (!child.pid) return false
          try {
            process.kill(-child.pid, killSignal)
            return true
          }
          catch {
            return false
          }
        }
        const terminate = () => {
          if (termination) return
          if (!killProcessGroup("SIGTERM")) {
            termination = Promise.resolve()
            return
          }
          termination = new Promise((resolve) => {
            forceKill = setTimeout(() => {
              killProcessGroup("SIGKILL")
              resolve()
            }, 250)
          })
        }
        signal?.addEventListener("abort", terminate, { once: true })
        if (signal?.aborted) terminate()
        child.stdout.setEncoding("utf8").on("data", chunk => stdout += chunk)
        child.stderr.setEncoding("utf8").on("data", chunk => stderr += chunk)
        // An aborted child emits `error` when termination is requested and
        // `close` only after its stdio and process have actually closed. Keep
        // the original failure, but do not let Workspace cleanup race the
        // still-live child.
        child.once("error", error => executionError = error)
        child.once("exit", terminate)
        child.once("close", (code) => {
          terminate()
          void termination!.then(() => {
            signal?.removeEventListener("abort", terminate)
            if (forceKill && !signal?.aborted) clearTimeout(forceKill)
            if (executionError) reject(executionError)
            else resolve({ code: code ?? 1, stderr, stdout })
          })
        })
      })
    },
  }
}

function workspaceSessionStarter(workspace: ReadonlyWorkspaceFacade) {
  type StartSession = (options?: WorkspaceSessionOptions) => Promise<WorkspaceSession>
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  const facade = workspace as ReadonlyWorkspaceFacade & { startSession?: StartSession }
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  const files = workspace.fs as typeof workspace.fs & { startSession?: StartSession }
  const startSession = facade.startSession || files.startSession
  if (!startSession) throw new Error("[vitehub] Provider Agent Driver workspace requires Workspace Session support.")
  return startSession.bind(facade.startSession ? workspace : files)
}

function selectedWorkspacePaths(context: AgentAdapterRunContext): readonly string[] | undefined {
  const required = [...new Set(context.workspaceMaterializationPaths || [])]
  if (!hasTrustedWorkspaceAccessScope(context.context)) return undefined
  const scope = context.context.get("access")?.workspaceScope
  if (!scope || scope.all) return undefined
  const paths = [...new Set([...(scope.paths || []), ...required])]
  return paths.length ? paths : []
}

async function materializeWorkspaceSources(context: AgentAdapterRunContext, paths: readonly string[] | undefined) {
  const workspace = context.workspaceMaterializationSource || context.workspace
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  const materialize = (workspace as ReadonlyWorkspaceFacade & { materializeSources?: ReadonlyWorkspaceFacade["fs"]["materializeSources"] } | undefined)?.materializeSources
    || workspace?.fs.materializeSources
  if (!materialize || (paths && !paths.length)) return
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  const owner = (workspace as { materializeSources?: unknown } | undefined)?.materializeSources ? workspace : workspace?.fs
  await Promise.all((paths || [""]).map(path => materialize.call(owner, { abortSignal: context.input.abortSignal, path })))
}

async function prepareWorkspace(context: AgentAdapterRunContext, root: string): Promise<WorkspaceSession | undefined> {
  if (!context.workspace) return
  if (process.platform === "win32") {
    throw new Error("[vitehub] Provider Agent Driver Workspaces require a POSIX Node host.")
  }
  const paths = selectedWorkspacePaths(context)
  await materializeWorkspaceSources(context, paths)
  const sessionOptions: WorkspaceSessionOptions = {
    abortSignal: context.input.abortSignal,
    host: localWorkspaceHost(),
    paths,
    target: root,
  }
  if (context.workspaceMode !== "write") sessionOptions.writeBack = false
  const session = await workspaceSessionStarter(context.workspace)(sessionOptions)
  await session.exec("git", ["init", "-q"], { abortSignal: context.input.abortSignal }).catch(() => undefined)
  return session
}

async function closeWorkspace(context: AgentAdapterRunContext, session: WorkspaceSession | undefined, error: unknown, abortSignal: AbortSignal) {
  if (!session) return
  try {
    if (error || !context.workspaceDefinition || context.workspaceMode !== "write") return
    const diff = await session.diff({ abortSignal })
    const definition = workspaceDefinitionWithAutoCommitRules(context.workspaceDefinition, context.workspaceAutoCommit)
    const commit = resolveWorkspaceAutoCommit(definition, diff)
    if (!commit) return
    await session.commit({ abortSignal, message: commit.message || "provider-workspace-session" })
    setAgentWorkspaceDiff(context.context, diff)
  }
  finally {
    await session.close({ abortSignal })
  }
}

async function resolveInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(options: ProviderAgentAdapterOptions<TRuntimeConfig, CALL_OPTIONS>, context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>): Promise<string | undefined> {
  const { runtimeConfig: _runtimeConfig, ...runtime } = context.runtime
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  const metadataContext = {
    ...agentInvocationCallbackContextValues(context.context),
    ...runtime,
    actor: context.actor,
    context: context.context,
    fs: context.workspace?.fs,
    invoker: context.invoker,
    workspace: context.workspace,
  } as AgentAdapterMetadataContext
  const parts = Array.isArray(options.instructions) ? options.instructions : [options.instructions]
  const configured = await Promise.all(parts.map(part => hasRuntimeType(part, "function") ? part(metadataContext) : part))
  const content = [
    ...configured.flatMap(value => Array.isArray(value) ? value : [value]),
    context.instructions,
    resolveMessageChannelInstructions(context.context, context),
    agentOutputInstructions(context.output),
  ].map(value => value?.trim()).filter((value): value is string => Boolean(value)).join("\n\n")
  return content ? await composeInstructionDocument(content, {
    context: context.context.toJSON(),
    workspace: context.workspaceInstructionBindings,
  }) : undefined
}

function latestUserMessages(messages: Message[]): Message[] {
  const index = messages.findLastIndex(message => message.role === "user")
  return index === -1 ? messages.slice(-1) : messages.slice(index)
}

function providerPrompt(messages: Message[], resumed: boolean, prompt?: string): string | undefined {
  if (!messages.length) return prompt?.trim() || undefined
  const selected = resumed ? latestUserMessages(messages) : messages
  if (selected.length === 1 && selected[0]?.role === "user") return getMessageText(selected[0]).trim() || undefined
  const content = selected.flatMap((message) => {
    const text = getMessageText(message).trim()
    return text ? [`<message role="${message.role}">\n${text}\n</message>`] : []
  }).join("\n")
  return content || prompt?.trim() || undefined
}

function attachmentId(threadId: string): string {
  const prefix = threadId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 80).replace(/[-_]+$/g, "") || "thread"
  return `${prefix}-${crypto.randomUUID()}`
}

const defaultProviderAttachmentMaxBytes = 25 * 1024 * 1024

async function attachmentBytes(part: AttachmentPart, maxBytes: number): Promise<Uint8Array> {
  if (hasRuntimeType(part.size, "number") && part.size > maxBytes) throw new Error(`[vitehub] Provider attachment exceeds maxBytes (${maxBytes}).`)
  const data = await resolveAttachmentData(part)
  if (data === undefined && part.url) {
    throw new TypeError("[vitehub] Provider attachment URLs require application-owned fetchData() resolution.")
  }
  if (data === undefined) throw new TypeError(`[vitehub] Provider ${part.type} attachment requires data or fetchData().`)
  const declaredSize = data instanceof Blob ? data.size : data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data.byteLength : undefined
  if (declaredSize !== undefined && declaredSize > maxBytes) throw new Error(`[vitehub] Provider attachment exceeds maxBytes (${maxBytes}).`)
  if (hasRuntimeType(data, "string") && data.length > maxBytes * 2) throw new Error(`[vitehub] Provider attachment exceeds maxBytes (${maxBytes}).`)
  const bytes = data instanceof Blob
    ? new Uint8Array(await data.arrayBuffer())
    : data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : attachmentStringBytes(data, part.mediaType)
  if (bytes.byteLength > maxBytes) throw new Error(`[vitehub] Provider attachment exceeds maxBytes (${maxBytes}).`)
  return bytes
}

async function prepareAttachments(runtime: ProviderRuntime, context: AgentAdapterRunContext, threadId: ThreadId, maxBytes: number) {
  const parts = currentInputAttachments(context.messages, context.runtime.run?.messageId)
  if (!parts.length) return
  let remaining = maxBytes
  await mkdir(runtime.attachmentsDirectory, { recursive: true })
  const attachments = []
  for (const part of parts) {
    if (part.type !== "image") throw new TypeError("[vitehub] Provider Agent Drivers currently support image attachments only.")
    const id = attachmentId(threadId)
    const extension = imageExtensions[part.mediaType.toLowerCase()] || extname(part.name || "").toLowerCase() || ".bin"
    const bytes = await attachmentBytes(part, remaining)
    remaining -= bytes.byteLength
    await writeFile(join(runtime.attachmentsDirectory, `${id}${extension}`), bytes)
    attachments.push({
      id,
      mimeType: part.mediaType,
      name: part.name || basename(`${id}${extension}`),
      sizeBytes: bytes.byteLength,
      // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
      type: "image" as const,
    })
  }
  return attachments
}

function approvalDecision(approved: boolean): ProviderApprovalDecision {
  return approved ? "accept" : "decline"
}

async function respondToInput(runtime: ProviderRuntime, threadId: ThreadId, messages: Message[], approvals: Map<string, (approved: boolean) => boolean>, capabilityApprovalIds: Set<string>): Promise<boolean> {
  let responded = false
  for (const part of latestUserMessages(messages).flatMap(message => message.parts)) {
    if (part.type === "approval-decision") {
      const resolveApproval = approvals.get(part.id)
      if (resolveApproval) {
        responded = resolveApproval(part.approved) || responded
      }
      else if (!capabilityApprovalIds.has(part.id)) {
        responded = true
        // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
        await runtime.respondToRequest(threadId, part.id as never, approvalDecision(part.approved))
      }
    }
    if (part.type === "data-agent-input" && part.data && hasRuntimeType(part.data, "object")) {
      // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
      const data = part.data as { answers?: unknown, requestId?: unknown }
      if (hasRuntimeType(data.requestId, "string") && data.answers && hasRuntimeType(data.answers, "object")) {
        responded = true
        // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
        await runtime.respondToUserInput(threadId, data.requestId as never, data.answers as ProviderUserInputAnswers)
      }
    }
  }
  return responded
}

function usageEvent(event: Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>): StreamEvent {
  const usage = event.payload.usage
  const inputTokens = usage.inputTokens ?? usage.lastInputTokens
  const outputTokens = usage.outputTokens ?? usage.lastOutputTokens
  return {
    type: "usage",
    usageRecord: {
      latency: usage.durationMs === undefined ? undefined : { durationMs: usage.durationMs },
      raw: usage,
      usage: {
        details: {
          ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
          ...(usage.reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens: usage.reasoningOutputTokens }),
          ...(usage.toolUses === undefined ? {} : { toolUses: usage.toolUses }),
        },
        inputTokens,
        outputTokens,
        totalTokens: usage.totalProcessedTokens ?? usage.usedTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
      },
    },
  }
}

function providerDataEvent(event: ProviderRuntimeEvent): StreamEvent {
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  const payload = event.payload as Record<string, unknown>
  const id = event.itemId
    || (hasRuntimeType(payload.toolUseId, "string") ? payload.toolUseId : undefined)
    || (hasRuntimeType(payload.taskId, "string") ? payload.taskId : undefined)
    || event.requestId
    || event.turnId
    || event.eventId
  return { data: { kind: event.type, value: event.payload }, id, type: "data-agent-event" }
}

const providerDataItemTypes = new Set(["user_message", "assistant_message", "reasoning", "plan", "review_entered", "review_exited", "context_compaction", "error", "unknown"])

function isProviderToolItem(itemId: string | undefined, itemType: string): itemId is string {
  return Boolean(itemId) && !providerDataItemTypes.has(itemType)
}

function record(value: unknown): Record<string, unknown> | undefined {
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  return value && hasRuntimeType(value, "object") && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function providerResultError(value: unknown): string | undefined {
  const content = record(value)?.content
  if (hasRuntimeType(content, "string")) return content || undefined
  if (!Array.isArray(content)) return
  const text = content.flatMap((part) => {
    const block = record(part)
    return hasRuntimeType(block?.text, "string") && block.text ? [block.text] : []
  }).join("\n")
  return text || undefined
}

function providerToolName(event: Extract<ProviderRuntimeEvent, { type: "item.completed" | "item.started" }>): string | undefined {
  const data = record(event.payload.data)
  const item = record(data?.item)
  return hasRuntimeType(data?.toolName, "string")
    ? data.toolName
    : hasRuntimeType(item?.tool, "string")
      ? item.tool
      : undefined
}

function providerToolDetails(event: Extract<ProviderRuntimeEvent, { type: "item.completed" | "item.started" }>) {
  const data = record(event.payload.data)
  const item = record(data?.item)
  const error = record(item?.error)
  const errorMessage = hasRuntimeType(error?.message, "string") ? error.message : providerResultError(data?.result)
  const isMcpTool = event.payload.itemType === "mcp_tool_call"
  const isCodexMcpTool = isMcpTool && item?.type === "mcpToolCall"
  const title = event.payload.title
  const failed = event.payload.status === "failed"
    || event.payload.status === "declined"
    || item?.status === "failed"
    || item?.status === "declined"
  return {
    durationMs: hasRuntimeType(item?.durationMs, "number") ? item.durationMs : undefined,
    error: failed
      ? errorMessage || event.payload.detail || "Provider tool failed."
      : undefined,
    input: isCodexMcpTool ? item.arguments : isMcpTool && data?.input !== undefined ? data.input : event.payload.data,
    output: isCodexMcpTool ? item.result : isMcpTool && data?.result !== undefined ? data.result : event.payload.data ?? event.payload.detail,
    title: isMcpTool && hasRuntimeType(title, "string") && title !== "MCP tool call" && title.trim() ? title : undefined,
  }
}

function providerToolActivity(
  event: Extract<ProviderRuntimeEvent, { type: "item.completed" | "item.started" }>,
  tools: AgentToolSet | undefined,
) {
  const name = providerToolName(event)
  // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
  return name && tools?.[name]?.activity ? tools[name].activity : { kind: "tool" as const }
}

function providerEvent(event: ProviderRuntimeEvent, tools?: AgentToolSet): StreamEvent[] {
  switch (event.type) {
    case "content.delta":
      if (event.payload.streamKind === "assistant_text") return [{ phase: "final", text: event.payload.delta, type: "text-delta" }]
      if (event.payload.streamKind === "command_output") return [providerDataEvent(event)]
      return [{ phase: "commentary", text: event.payload.delta, type: "text-delta" }]
    case "item.started": {
      const details = providerToolDetails(event)
      return isProviderToolItem(event.itemId, event.payload.itemType)
        ? [{ activity: providerToolActivity(event, tools), id: event.itemId, input: details.input, name: providerToolName(event) || event.payload.title || event.payload.itemType, title: details.title, type: "tool-call" }]
        : [providerDataEvent(event)]
    }
    case "item.completed":
      return isProviderToolItem(event.itemId, event.payload.itemType)
        ? [{
            activity: providerToolActivity(event, tools),
            ...providerToolDetails(event),
            id: event.itemId,
            name: providerToolName(event) || event.payload.title || event.payload.itemType,
            type: "tool-result",
          }]
        : event.payload.itemType === "error" && event.payload.detail
          ? [{ error: event.payload.detail, type: "error" }]
          : [providerDataEvent(event)]
    case "request.opened":
      return event.requestId ? [{ id: event.requestId, input: event.payload.args, name: event.payload.requestType, reason: event.payload.detail, type: "approval-request" }] : [providerDataEvent(event)]
    case "request.resolved":
      return event.requestId ? [{ approved: event.payload.decision === "accept" || event.payload.decision === "acceptForSession", id: event.requestId, reason: event.payload.decision, type: "approval-decision" }] : [providerDataEvent(event)]
    case "user-input.requested":
      return event.requestId ? [{ data: { questions: event.payload.questions, requestId: event.requestId, status: "requested" }, type: "data-agent-input" }] : [providerDataEvent(event)]
    case "user-input.resolved":
      return event.requestId ? [{ data: { answers: event.payload.answers, requestId: event.requestId, status: "resolved" }, type: "data-agent-input" }] : [providerDataEvent(event)]
    case "thread.token-usage.updated":
      return [usageEvent(event)]
    case "runtime.error":
      return [{ error: event.payload.message, type: "error" }]
    case "runtime.warning":
    case "config.warning":
    case "deprecation.notice":
      return [{ error: "message" in event.payload ? event.payload.message : event.payload.summary, recoverable: true, type: "error" }]
    case "thread.realtime.error":
      return [{ error: event.payload.message, recoverable: true, type: "error" }]
    case "session.exited":
      return event.payload.exitKind === "error" ? [{ error: event.payload.reason || "Provider session exited.", recoverable: event.payload.recoverable, type: "error" }] : [providerDataEvent(event)]
    case "turn.completed":
      const error = event.payload.errorMessage || (event.payload.state === "completed" ? undefined : `Provider turn ${event.payload.state}.`)
      return error
        ? [{ error, type: "error" }]
        : [{ reason: event.payload.stopReason || event.payload.state, type: "finish" }]
    case "turn.aborted":
      return [{ error: `Provider turn aborted${event.payload.reason ? `: ${event.payload.reason}` : "."}`, type: "error" }]
    case "turn.plan.updated":
      return [{ data: event.payload, id: event.turnId ? `plan:${event.turnId}` : undefined, type: "data-agent-plan" }]
    case "turn.diff.updated":
      return [{ data: event.payload, id: event.turnId ? `change:${event.turnId}` : undefined, type: "data-agent-diff" }]
    case "item.updated":
    case "tool.progress":
    case "tool.summary":
    case "task.started":
    case "task.progress":
    case "task.updated":
    case "task.completed":
      return [providerDataEvent(event)]
    default:
      return [providerDataEvent(event)]
  }
}

function isTerminalEvent(event: ProviderRuntimeEvent, turnId: TurnId): boolean {
  return event.turnId === turnId && (event.type === "turn.completed" || event.type === "turn.aborted")
}

async function* runProvider<
  CALL_OPTIONS,
  TRuntimeConfig extends AgentRuntimeConfig,
>(
  options: ProviderAgentAdapterOptions<TRuntimeConfig, CALL_OPTIONS>,
  resumeCursors: Map<string, unknown>,
  sessionLocks: Map<string, Promise<void>>,
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
): AsyncIterable<StreamEvent> {
  if (context.runtime.runtime === "cloudflare-agents" || context.runtime.runtime === "deno") {
    throw new Error(`[vitehub] Provider Agent Drivers require a Node.js host; ${context.runtime.runtime} cannot start local coding agents.`)
  }
  if (context.providerTools?.length) {
    throw new Error("[vitehub] Provider Agent Drivers do not accept model-specific Provider Tools. Use Capability tools or native provider tools.")
  }
  if (context.input.timeout !== undefined && context.input.timeout > 2_147_483_647) {
    throw new TypeError("[vitehub] Provider Agent timeout must be no greater than 2,147,483,647 milliseconds.")
  }
  const timeoutSignal = context.input.timeout === undefined ? undefined : AbortSignal.timeout(context.input.timeout)
  const effectiveSignal = context.input.abortSignal && timeoutSignal
    ? AbortSignal.any([context.input.abortSignal, timeoutSignal])
    : context.input.abortSignal || timeoutSignal
  context = effectiveSignal === context.input.abortSignal ? context : { ...context, input: { ...context.input, abortSignal: effectiveSignal } }
  effectiveSignal?.throwIfAborted()
  const transportSessionId = context.runtime.run?.threadId
  const chatSessionId = context.context.get("chat.sessionId")
  const sessionId = chatSessionId || transportSessionId
  const sessionKey = sessionId
    ? JSON.stringify([context.runtime.run?.origin || "unknown", context.invoker.kind, context.invoker.id, sessionId])
    : undefined
  const releaseSessionLock = sessionKey ? await acquireProviderSessionLock(sessionLocks, sessionKey, effectiveSignal) : undefined
  let root: string
  const providerEnvironmentOverrides = options.env
  try {
    effectiveSignal?.throwIfAborted()
    root = await mkdtemp(join(tmpdir(), "vitehub-provider-"))
  }
  catch (error) {
    releaseSessionLock?.()
    throw error
  }
  let workspaceSession: WorkspaceSession | undefined
  let runtime: ProviderRuntime | undefined
  let toolServer: Awaited<ReturnType<typeof startToolServer>> | undefined
  const pendingToolEvents: StreamEvent[] = []
  const capabilityApprovals = new Map<string, (approved: boolean) => boolean>()
  const capabilityApprovalIds = new Set<string>()
  let notifyToolEvent: (() => void) | undefined
  const emitToolEvent = (event: StreamEvent) => {
    pendingToolEvents.push(event)
    notifyToolEvent?.()
    notifyToolEvent = undefined
  }
  const waitForToolEvent = async () => {
    if (!pendingToolEvents.length) await new Promise<void>(resolve => notifyToolEvent = resolve)
  }
  let caught: unknown
  let completed = false
  let abort: (() => void) | undefined
  let unregister: (() => void) | undefined
  const generatedProviderFiles: GeneratedProviderFile[] = []
  let pendingResumeCursor = sessionKey ? resumeCursors.get(sessionKey) : undefined
  let runtimeCleanupDeferred = false
  let deferredRuntimeCleanup: Promise<void> | undefined
  let releaseDeferredRuntimeStopped: (() => void) | undefined
  const deferredRuntimeStopped = new Promise<void>((resolve) => {
    releaseDeferredRuntimeStopped = resolve
  })
  let rootCleanup: Promise<void> | undefined
  const cleanupRoot = () => rootCleanup ??= removeProviderRoot(root)
  let workspaceCleanupDeferred = false
  let deferredWorkspaceCleanup: Promise<void> | undefined
  const activeWorkspaceCommands = new Set<Promise<unknown>>()
  let releaseWorkspaceCleanup: (() => void) | undefined
  const workspaceCleanup = new Promise<void>((resolve) => {
    releaseWorkspaceCleanup = resolve
  })
  let clearActiveWorkspaceCommands: (() => void) | undefined
  let clearActiveWorkspaceFiles: (() => void) | undefined
  const observeLateCleanup = (cleanup: Promise<void>) => {
    Object.defineProperty(cleanup, agentProviderCleanupTask, { value: true })
    void cleanup.catch(() => undefined)
    try {
      context.runtime.waitUntil(cleanup)
    }
    catch {}
  }
  const deferRuntimeCleanup = (cleanup: Promise<void>) => {
    runtimeCleanupDeferred = true
    deferredRuntimeCleanup = cleanup
    observeLateCleanup(cleanup)
  }
  const deferWorkspaceSessionCleanup = (cleanup: Promise<void>) => {
    workspaceCleanupDeferred = true
    deferredWorkspaceCleanup = cleanup
    observeLateCleanup(cleanup)
  }
  const finalizeDeferredRuntime = async (sessionThreadId?: ThreadId, turnId?: TurnId) => {
    try {
      if (sessionThreadId && turnId) await runtime!.interruptTurn(sessionThreadId, turnId).catch(() => undefined)
      if (sessionThreadId) await runtime!.stopSession(sessionThreadId)
    }
    finally {
      try {
        await runtime!.close()
      }
      finally {
        releaseDeferredRuntimeStopped?.()
        await workspaceCleanup
        await cleanupRoot()
      }
    }
  }
  try {
    effectiveSignal?.throwIfAborted()
    workspaceSession = await waitForProviderOperation(
      prepareWorkspace(context, root),
      effectiveSignal,
      async (lateSession) => {
        try {
          await lateSession?.close()
        }
        finally {
          await cleanupRoot()
        }
      },
      deferWorkspaceSessionCleanup,
      cleanupRoot,
    )
    if (workspaceSession) {
      clearActiveWorkspaceFiles = setActiveAgentWorkspaceFiles(context.context, {
        async readFile(path) {
          try {
            return { active: true, body: await workspaceSession!.readFile(path, { encoding: "binary" }) }
          }
          catch {
            return { active: true, body: undefined }
          }
        },
      })
      clearActiveWorkspaceCommands = setActiveAgentWorkspaceCommands(context.context, (command, args, execOptions) => {
        const execution = workspaceSession!.exec(command, args, execOptions)
        activeWorkspaceCommands.add(execution)
        void execution.finally(() => activeWorkspaceCommands.delete(execution)).catch(() => undefined)
        return execution
      })
    }
    let instructions = await waitForProviderOperation(resolveInstructions(options, context), effectiveSignal)
    let materializeInstructions = Boolean(instructions)
    if (!instructions && options.provider === "claude-code") {
      const nativeInstructions = await readFile(join(root, "CLAUDE.md"), "utf8").catch(() => undefined)
      if (nativeInstructions !== undefined) instructions = nativeInstructions
      else {
        instructions = await readFile(join(root, "AGENTS.md"), "utf8").catch(() => undefined)
        materializeInstructions = Boolean(instructions)
      }
    }
    await updateAgentTelemetryConfiguration(context.context, {
      driver: {
        ...(options.model ? { model: { id: options.model, provider: options.provider } } : {}),
        provider: options.provider,
      },
      ...(instructions ? { instructions: [instructions] } : {}),
      ...(Object.keys(context.tools || {}).length || context.providerTools?.length
        ? { tools: [...Object.keys(context.tools || {}), ...(context.providerTools || []).map(tool => tool.name)].sort().map(name => ({ name })) }
        : {}),
    })
    if (instructions && materializeInstructions) {
      const instructionFile = options.provider === "codex" ? "AGENTS.md" : "CLAUDE.md"
      generatedProviderFiles.push(await materializeGeneratedProviderFile(root, join(root, instructionFile), instructions))
    }
    const colocatedSkills = context.context.get(colocatedAgentSkillsContextKey)
    for (const source of Object.values(colocatedSkills || {})) {
      if (!isRuntimeRecord(source)
        || !("content" in source)
        || !("workspacePath" in source)
        || !(hasRuntimeType(source.content, "string") || source.content instanceof Uint8Array)
        || !hasRuntimeType(source.workspacePath, "string")) continue
      const target = resolve(root, source.workspacePath)
      if (target !== root && !target.startsWith(`${root}/`)) throw new Error("[vitehub] Colocated Skill path must stay inside the provider Workspace.")
      generatedProviderFiles.push(await materializeGeneratedProviderFile(root, target, source.content))
    }
    if (workspaceSession) {
      await workspaceSession.exec("git", ["add", "-A"], { abortSignal: effectiveSignal })
      await workspaceSession.exec("git", ["-c", "user.name=ViteHub", "-c", "user.email=vitehub@localhost", "commit", "--allow-empty", "-qm", "vitehub provider baseline"], { abortSignal: effectiveSignal })
    }
    effectiveSignal?.throwIfAborted()
    const { createProviderRuntime } = await import("@t3tools/provider-runtime")
    const finalizeLateRuntimeCreation = async () => {
      releaseDeferredRuntimeStopped?.()
      await workspaceCleanup
      await cleanupRoot()
    }
    runtime = await waitForProviderOperation(
      createProviderRuntime({ cwd: root, environment: providerEnvironment(providerEnvironmentOverrides), provider: options.provider }),
      effectiveSignal,
      async lateRuntime => {
        try {
          await lateRuntime.close()
        }
        finally {
          await finalizeLateRuntimeCreation()
        }
      },
      deferRuntimeCleanup,
      finalizeLateRuntimeCreation,
    )
    effectiveSignal?.throwIfAborted()
    if (Object.keys(context.tools || {}).length) toolServer = await startToolServer(context.tools!, effectiveSignal, emitToolEvent, capabilityApprovals, capabilityApprovalIds)
    const events = runtime.events[Symbol.asyncIterator]()
    let nextEvent = events.next()
    // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
    const threadId = (transportSessionId || crypto.randomUUID()) as ThreadId
    const resumed = Boolean(sessionKey && resumeCursors.has(sessionKey))
    effectiveSignal?.throwIfAborted()
    const session = await waitForProviderOperation(runtime.startSession({
      cwd: root,
      mcp: toolServer?.mcp,
      model: options.model,
      resumeCursor: sessionKey ? resumeCursors.get(sessionKey) : undefined,
      runtimeMode: providerRuntimeMode[options.permissions ?? defaultAgentProviderPermissions],
      threadId,
    }), effectiveSignal, session => finalizeDeferredRuntime(session.threadId), deferRuntimeCleanup, () => finalizeDeferredRuntime())
    if (session.resumeCursor !== undefined) pendingResumeCursor = session.resumeCursor
    const attachments = await waitForProviderOperation(
      prepareAttachments(runtime, context, threadId, options.execution?.attachments?.maxBytes ?? defaultProviderAttachmentMaxBytes),
      effectiveSignal,
      () => finalizeDeferredRuntime(threadId),
      deferRuntimeCleanup,
      () => finalizeDeferredRuntime(threadId),
    )
    const prompt = providerPrompt(context.messages, resumed, context.prompt) || (attachments?.length ? "Inspect the attached image." : undefined)
    if (!prompt) throw new Error("[vitehub] Provider Agent Driver invocation requires a prompt, user message, or image attachment.")
    effectiveSignal?.throwIfAborted()
    const activeRuntime = runtime
    const invocationId = agentInvocationControlId(context.runtime)
    if (invocationId && !isAuxiliaryAgentAdapterContext(context)) {
      unregister = registerAgentInvocationInputHandler(invocationId, {
        async sendInput(input, inputOptions) {
          if (inputOptions.mode !== "respond") return "unsupported"
          try {
            const messages = input.messages || (hasRuntimeType(input.message, "object") ? [input.message] : Array.isArray(input.prompt) ? input.prompt : [])
            return await respondToInput(activeRuntime, threadId, messages, capabilityApprovals, capabilityApprovalIds) ? "accepted" : "unsupported"
          }
          catch {
            return "unavailable"
          }
        },
        support: { respond: true },
      })
    }
    const turn = await waitForProviderOperation(
      runtime.sendTurn({ attachments, input: prompt, threadId }),
      effectiveSignal,
      lateTurn => finalizeDeferredRuntime(threadId, lateTurn.turnId),
      deferRuntimeCleanup,
      () => finalizeDeferredRuntime(threadId),
    )
    if (turn.resumeCursor !== undefined) pendingResumeCursor = turn.resumeCursor
    let rejectAbort: ((reason: unknown) => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    abort = () => {
      void activeRuntime.interruptTurn(threadId, turn.turnId).catch(() => undefined)
      rejectAbort?.(effectiveSignal?.reason ?? new DOMException("[vitehub] Provider Agent Driver invocation aborted.", "AbortError"))
    }
    if (effectiveSignal?.aborted) abort()
    else effectiveSignal?.addEventListener("abort", abort, { once: true })
    for (;;) {
      if (pendingToolEvents.length) {
        yield pendingToolEvents.shift()!
        continue
      }
      const raced = await Promise.race([
        nextEvent.then(result => ({ provider: result })),
        // SAFETY: Provider driver normalization establishes the asserted provider runtime contract.
        waitForToolEvent().then(() => ({ tool: true as const })),
        aborted,
      ])
      if ("tool" in raced) {
        yield pendingToolEvents.shift()!
        continue
      }
      const current = raced.provider
      if (current.done) throw new Error("[vitehub] Provider Agent Driver event stream ended before the turn completed.")
      if (current.value.threadId && current.value.threadId !== threadId) {
        nextEvent = events.next()
        continue
      }
      if ((!invocationId || isAuxiliaryAgentAdapterContext(context)) && current.value.type === "request.opened" && current.value.requestId) {
        // SAFETY: A request.opened event always carries the provider approval request identifier expected by respondToRequest.
        await activeRuntime.respondToRequest(threadId, current.value.requestId as never, "decline")
      }
      const normalized = providerEvent(current.value, context.tools)
      const failure = normalized.find(event => event.type === "error" && !event.recoverable)
      if (failure?.type === "error") caught = new Error(failure.error)
      if (current.value.type === "session.exited") {
        caught = new Error(`[vitehub] Provider Agent Driver session exited before the turn completed${current.value.payload.reason ? `: ${current.value.payload.reason}` : "."}`)
      }
      if (current.value.turnId === turn.turnId && current.value.type === "turn.aborted") {
        caught = effectiveSignal?.aborted
          ? effectiveSignal.reason ?? new DOMException("[vitehub] Provider Agent Driver invocation aborted.", "AbortError")
          : new Error(`[vitehub] Provider Agent Driver turn aborted${current.value.payload.reason ? `: ${current.value.payload.reason}` : "."}`)
        if (effectiveSignal?.aborted) throw caught
      }
      if (isTerminalEvent(current.value, turn.turnId) && !caught) completed = true
      while (pendingToolEvents.length) yield pendingToolEvents.shift()!
      for (const event of normalized) yield event
      if (caught) throw caught
      if (isTerminalEvent(current.value, turn.turnId)) break
      nextEvent = events.next()
    }
  }
  catch (error) {
    caught = error
    throw error
  }
  finally {
    unregister?.()
    clearActiveWorkspaceCommands?.()
    clearActiveWorkspaceFiles?.()
    if (abort) effectiveSignal?.removeEventListener("abort", abort)
    const cleanupErrors: unknown[] = []
    const cleanup = createProviderCleanupSignal(completed ? undefined : effectiveSignal)
    let cleanupTimedOut = false
    let invocationCleanupDeferred: Promise<void> | undefined
    let forcedRootCleanup: Promise<void> | undefined
    const cleanupTask = (async () => {
      const runtimeAndToolCleanup = await Promise.allSettled([
        runtimeCleanupDeferred ? undefined : runtime?.close(),
        toolServer?.close(),
      ])
      for (const result of runtimeAndToolCleanup) {
        const repeatsInvocationFailure = caught !== undefined
          && result.status === "rejected"
          && (result.reason === caught || result.reason === effectiveSignal?.reason)
        if (result.status === "rejected" && !repeatsInvocationFailure) cleanupErrors.push(result.reason)
      }
      for (const result of await Promise.allSettled(activeWorkspaceCommands)) {
        if (result.status === "rejected" && !caught) cleanupErrors.push(result.reason)
      }
      const finalizeWorkspace = async () => {
        try {
          for (const generated of generatedProviderFiles.reverse()) await restoreGeneratedProviderFile(generated)
        }
        catch (error) {
          cleanupErrors.push(error)
        }
        try {
          await closeWorkspace(
            context,
            workspaceSession,
            caught ?? cleanupErrors[0] ?? (completed ? undefined : new Error("[vitehub] Provider Agent Driver invocation did not complete.")),
            cleanup.signal,
          )
        }
        catch (error) {
          cleanupErrors.push(error)
        }
        finally {
          releaseWorkspaceCleanup?.()
        }
      }
      if (runtimeCleanupDeferred) void deferredRuntimeStopped.then(finalizeWorkspace)
      else await finalizeWorkspace()
      if (!runtimeCleanupDeferred && !workspaceCleanupDeferred) {
        try {
          await cleanupRoot()
        }
        catch (error) {
          cleanupErrors.push(error)
        }
      }
    })()
    try {
      await waitForProviderOperation(cleanupTask, cleanup.signal)
    }
    catch (error) {
      cleanupTimedOut = providerCleanupTimedOut(error)
      const repeatsInvocationFailure = caught !== undefined && (error === caught || error === effectiveSignal?.reason)
      if (!repeatsInvocationFailure) cleanupErrors.push(error)
      if (cleanupTimedOut) {
        forcedRootCleanup = cleanupRoot()
        observeLateCleanup(forcedRootCleanup)
        void cleanupTask.catch(() => undefined)
      }
      else if (repeatsInvocationFailure && !runtimeCleanupDeferred && !workspaceCleanupDeferred) {
        let timeout: ReturnType<typeof setTimeout> | undefined
        invocationCleanupDeferred = Promise.race([
          cleanupTask,
          new Promise<void>(resolve => timeout = setTimeout(resolve, providerCleanupTimeoutMs)),
        ]).finally(async () => {
          if (timeout) clearTimeout(timeout)
          await cleanupRoot()
        })
        observeLateCleanup(invocationCleanupDeferred)
        void cleanupTask.catch(() => undefined)
      }
    }
    finally {
      cleanup.dispose()
    }
    const deferredCleanup = forcedRootCleanup || invocationCleanupDeferred || (cleanupTimedOut ? cleanupTask : deferredRuntimeCleanup || deferredWorkspaceCleanup)
    if (deferredCleanup) void deferredCleanup.then(releaseSessionLock, releaseSessionLock)
    else releaseSessionLock?.()
    if (sessionKey) {
      if (completed && caught === undefined && cleanupErrors.length === 0 && pendingResumeCursor !== undefined) {
        resumeCursors.set(sessionKey, pendingResumeCursor)
      }
      else {
        resumeCursors.delete(sessionKey)
      }
    }
    if (cleanupErrors.length) {
      const cleanupError = new AggregateError(caught === undefined ? cleanupErrors : [caught, ...cleanupErrors], "[vitehub] Provider Agent Driver cleanup failed.")
      if (completed && caught === undefined && cleanupErrors.every(providerCleanupTimedOut)) {
        yield { error: cleanupError.message, recoverable: true, type: "error" }
      }
      else throw cleanupError
    }
  }
}

async function generateProvider<CALL_OPTIONS, TRuntimeConfig extends AgentRuntimeConfig>(
  iterable: AsyncIterable<StreamEvent>,
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
): Promise<AgentAdapterResult> {
  let text = ""
  let finishReason: unknown
  let usageRecord: AgentAdapterResult["usageRecord"]
  const tracer = context.runtime.traceLog
    ? createAgentStreamEventTracer({ context: context.context, input: context.input, invoker: context.invoker, run: context.runtime.run, runtime: context.runtime })
    : undefined
  try {
    for await (const event of iterable) {
      await tracer?.write(event)
      if (event.type === "text-delta" && event.phase !== "commentary") text += event.text
      else if (event.type === "usage") usageRecord = event.usageRecord
      else if (event.type === "finish") finishReason = event.reason
      else if (event.type === "error" && !event.recoverable) throw new Error(event.error)
    }
  }
  finally {
    await tracer?.flush()
  }
  return { finishReason, text, usageRecord }
}

export function createProviderAgentAdapter<
  CALL_OPTIONS = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
>(options: ProviderAgentAdapterOptions<TRuntimeConfig, CALL_OPTIONS>): AgentAdapter<CALL_OPTIONS, TRuntimeConfig> {
  const resumeCursors = new Map<string, unknown>()
  const sessionLocks = new Map<string, Promise<void>>()
  return {
    generate: context => generateProvider(runProvider(options, resumeCursors, sessionLocks, context), context),
    async metadata(context) {
      const parts = Array.isArray(options.instructions) ? options.instructions : [options.instructions]
      const instructions = await Promise.all(parts.map(part => hasRuntimeType(part, "function") ? part(context) : part))
      return {
        instructions: instructions.flatMap(value => Array.isArray(value) ? value : value ? [value] : []),
      }
    },
    name: options.provider,
    stream: context => streamAgentOutputToEvents(runProvider(options, resumeCursors, sessionLocks, context)),
  }
}
