import {
  createHarnessUsageMetadata,
  defineAgentUsageMetadata,
} from "./internal/agent-usage-metadata.ts"
import { hasTrustedWorkspaceAccessScope } from "./access-runtime.ts"
import { streamAgentOutputToEvents } from "./agent-output.ts"
import { composeInstructionDocument } from "./instruction-composition.ts"
import { colocatedAgentInstructionsSourceKey, resolveColocatedAgentInstructionDocument } from "./workspace-agent.ts"
import { normalizeAgentWorkspaceSources } from "./workspace-source-metadata.ts"
import { nextWithAbort } from "./internal/abortable-stream.ts"
import { toAiSdkModelMessages } from "./ai-sdk.ts"
import { isAsyncIterable } from "./internal/stream-result.ts"
import {
  applyAgentToolPolicies,
  withAgentToolStepReporting,
  withJsonCompatibleToolOutputs,
} from "./tool-runtime.ts"

import type {
  AgentAdapter,
  AgentAdapterRunContext,
  AgentDriverContributionKind,
  AgentHarnessCredentialSource,
  AgentHarnessDriverInput,
  AgentHarnessSandboxProviderInput,
  AgentHarnessSessionKey,
  AgentRunCallbackContext,
  AgentRuntimeConfig,
  AgentToolSet,
  MaybePromise,
} from "./types.ts"
import type { Message } from "./messages.ts"

type HarnessAgentLike = {
  createSession: (options?: Record<string, unknown>) => MaybePromise<HarnessAgentSessionLike>
  generate: (input: Record<string, unknown>) => MaybePromise<unknown>
  stream: (input: Record<string, unknown>) => MaybePromise<unknown>
  tools?: unknown
}

type HarnessAgentSessionLike = {
  destroy: () => MaybePromise<void>
  detach?: () => MaybePromise<unknown>
}

type HarnessInstructionSandbox = {
  writeBinaryFile(options: { abortSignal?: AbortSignal, content: Uint8Array, path: string }): MaybePromise<void>
}

type HarnessAgentConstructor = new (settings: Record<string, unknown>) => HarnessAgentLike
const harnessResumeStates = new WeakMap<object, Map<string, unknown>>()
const harnessInstructionFiles = ["AGENTS.md", "CLAUDE.md"] as const

interface HarnessAgentAdapterOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  credentials?: AgentHarnessCredentialSource
  harness: AgentHarnessDriverInput<TRuntimeConfig, CALL_OPTIONS>
  harnessSandbox?: AgentHarnessSandboxProviderInput<TRuntimeConfig, CALL_OPTIONS>
  sessionKey?: AgentHarnessSessionKey<TRuntimeConfig, CALL_OPTIONS>
}

function hasEntries(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0
}

function defaultHarnessPermissionMode(harness: unknown): "allow-all" | "allow-edits" {
  if (
    hasEntries(harness)
    && harness.harnessId === "claude-code"
    && typeof process.getuid === "function"
    && process.getuid() === 0
  ) {
    return "allow-edits"
  }
  return "allow-all"
}

function unsupportedHarnessContributionKinds(context: AgentAdapterRunContext): Set<AgentDriverContributionKind> {
  const kinds = new Set<AgentDriverContributionKind>()
  if (context.providerTools?.length) kinds.add("provider tools")
  return kinds
}

function formatContributionNames(names: Iterable<string> | undefined): string {
  const uniqueNames = Array.from(new Set(names || [])).filter(Boolean).sort()
  return uniqueNames.length ? ` (${uniqueNames.join(", ")})` : ""
}

function formatUnsupportedHarnessContributions(context: AgentAdapterRunContext): string[] {
  const unsupportedKinds = unsupportedHarnessContributionKinds(context)
  if (!unsupportedKinds.size) return []

  const contributed = new Map<string, { capabilityId: string, kind: AgentDriverContributionKind, names: Set<string> }>()
  for (const contribution of context.driverContributions || []) {
    if (!unsupportedKinds.has(contribution.kind)) continue
    const key = `${contribution.capabilityId}\0${contribution.kind}`
    const current = contributed.get(key) || {
      capabilityId: contribution.capabilityId,
      kind: contribution.kind,
      names: new Set<string>(),
    }
    for (const name of contribution.names || []) current.names.add(name)
    contributed.set(key, current)
  }

  if (contributed.size) {
    return Array.from(contributed.values()).map(contribution =>
      `${contribution.capabilityId}: ${contribution.kind}${formatContributionNames(contribution.names)}`,
    )
  }

  return [
    unsupportedKinds.has("provider tools") ? "provider tools" : undefined,
  ].filter((value): value is string => Boolean(value))
}

function assertSupportedHarnessDriverContributions(context: AgentAdapterRunContext) {
  const unsupported = formatUnsupportedHarnessContributions(context)

  if (unsupported.length) {
    throw new Error(`[vitehub] Harness Agent Drivers do not support these Capability Driver Contributions yet: ${unsupported.join("; ")}. Move model-facing tools to harness-native workspace files or remove those capabilities for harness.`)
  }
}

function staticWorkspaceRulePath(pattern: string): string | undefined {
  const wildcard = pattern.search(/[*{[(?]/)
  const base = wildcard === -1 ? pattern : pattern.slice(0, wildcard)
  const normalized = base.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/+/g, "/")
  const parts = normalized.split("/").filter(Boolean)
  if (parts.some(part => part === "." || part === "..")) return
  return normalized
}

function workspaceRuleHarnessPaths(context: AgentAdapterRunContext): string[] {
  const definition = context.workspaceDefinition
  if (!definition) return []
  const rules = [
    ...Object.entries(definition.rules || {}),
    ...(definition.plugins || []).flatMap(plugin => Object.entries(plugin.rules || {})),
  ]
  return rules.flatMap(([pattern, rule]) => rule.write ? [staticWorkspaceRulePath(pattern)].filter((path): path is string => Boolean(path)) : [])
}

function workspaceSourceHarnessPaths(context: AgentAdapterRunContext): string[] {
  const sources = context.workspaceDefinition?.sources
  if (!sources) return []
  const scope = hasTrustedWorkspaceAccessScope(context.context)
    ? context.context.get("access")?.workspaceScope
    : undefined
  return normalizeAgentWorkspaceSources(sources).flatMap((source) => {
    if (source.scopes?.length && scope && !scope.all && !source.scopes.includes(scope.scope)) return []
    if (source.materialize === "build" && source.probeKeys?.length) {
      return source.probeKeys.map(key => [source.mountPath, key].filter(Boolean).join("/"))
    }
    if (source.materialize === "lazy") return [source.mountPath || ""]
    return []
  })
}

function pathContains(container: string, path: string): boolean {
  return !container || path === container || path.startsWith(`${container}/`)
}

function compactWorkspacePaths(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort((left, right) => left.length - right.length || left.localeCompare(right))
  return sorted.filter((path, index) => !sorted.some((candidate, candidateIndex) => candidateIndex < index && pathContains(candidate, path)))
}

function harnessSupportWorkspacePaths(context: AgentAdapterRunContext): string[] {
  return compactWorkspacePaths([
    ...(context.harnessWorkspacePaths || []),
    ...workspaceRuleHarnessPaths(context),
  ])
}

function withHarnessInstructionPaths(paths: readonly string[]): string[] {
  return paths.length ? compactWorkspacePaths([...harnessInstructionFiles, ...paths]) : []
}

function explicitHarnessWorkspacePaths(context: AgentAdapterRunContext): string[] {
  return withHarnessInstructionPaths([
    ...harnessSupportWorkspacePaths(context),
    ...workspaceSourceHarnessPaths(context),
  ])
}

function selectedWorkspaceScopePaths(context: AgentAdapterRunContext): string[] | undefined {
  const harnessPaths = explicitHarnessWorkspacePaths(context)
  if (!hasTrustedWorkspaceAccessScope(context.context)) return harnessPaths.length ? harnessPaths : undefined
  const scope = context.context.get("access")?.workspaceScope
  if (!scope) return harnessPaths.length ? harnessPaths : undefined
  if (scope.all) return harnessPaths.length ? harnessPaths : [""]
  const paths = [...new Set([...(scope.paths || []), ...harnessSupportWorkspacePaths(context)])]
  return paths.length ? withHarnessInstructionPaths(paths) : []
}

async function composeHarnessInstructions(content: string, context: AgentAdapterRunContext) {
  const compositionContext = { context: context.context.toJSON(), workspace: context.workspaceInstructionBindings }
  return await composeInstructionDocument(content, compositionContext)
}

function renderHarnessModelMessageContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content) && content.every(part => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")) {
    return content.map(part => (part as { text: string }).text).join("")
  }
  return JSON.stringify(content)
}

function renderHarnessChatPrompt(messages: Message[]): string {
  return [
    "Conversation history:",
    ...toAiSdkModelMessages(messages).map((message) => {
      const role = message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : message.role
      return `${role}: ${renderHarnessModelMessageContent(message.content)}`
    }),
    "",
    "Respond to the latest user message.",
  ].join("\n")
}

function latestHarnessUserMessage(messages: Message[]): Message[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === "user") return [message]
  }
  return messages.slice(-1)
}

async function toHarnessCallInput(context: AgentAdapterRunContext, resumesSession = false) {
  const instructions = await composeHarnessInstructions(context.instructions || "", context)
  const base = {
    abortSignal: context.input.abortSignal,
    ...(instructions ? { instructions } : {}),
    timeout: context.input.timeout,
    ...("options" in context.input ? { options: context.input.options } : {}),
  }

  if (context.messages.length) {
    if (context.context.has("chat")) {
      return {
        ...base,
        prompt: renderHarnessChatPrompt(resumesSession ? latestHarnessUserMessage(context.messages) : context.messages),
      }
    }
    return {
      ...base,
      messages: toAiSdkModelMessages(context.messages),
    }
  }
  if (context.prompt) {
    return {
      ...base,
      prompt: context.prompt,
    }
  }
  return {
    ...base,
    messages: [],
  }
}

function toHarnessTools(context: AgentAdapterRunContext): AgentToolSet | undefined {
  if (!hasEntries(context.tools)) return
  return withAgentToolStepReporting(
    withJsonCompatibleToolOutputs(applyAgentToolPolicies(context.tools as AgentToolSet) || {}),
    context.devtools?.reportToolStep,
  )
}

function toRunCallbackContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
): AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS> {
  const { runtimeConfig: _runtimeConfig, ...runtime } = context.runtime
  return {
    ...runtime,
    actor: context.actor,
    context: context.context,
    input: context.input,
    invoker: context.invoker,
    run: context.runtime.run,
  }
}

async function resolveHarnessSessionKey<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  sessionKey: AgentHarnessSessionKey<TRuntimeConfig, CALL_OPTIONS> | undefined,
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
): Promise<string | undefined> {
  if (typeof sessionKey === "function") {
    const resolved = await sessionKey(toRunCallbackContext(context))
    return resolved || undefined
  }
  return sessionKey || undefined
}

async function createDefaultHarnessSandbox(context: AgentAdapterRunContext) {
  if (context.workspace && context.runtime.runtime === "vite") {
    const { createLocalHarnessSandbox } = await import("./harness/local-sandbox.ts")
    return createLocalHarnessSandbox()
  }

  let sandboxModule: { createVercelSandbox: (settings: Record<string, unknown>) => unknown }
  try {
    sandboxModule = await import("@ai-sdk/sandbox-vercel") as typeof sandboxModule
  }
  catch (error) {
    throw new Error("[vitehub] defineAgent({ driver: { harness } }) requires @ai-sdk/sandbox-vercel for the default harness sandbox outside local Vite workspace runs.", { cause: error })
  }

  return sandboxModule.createVercelSandbox({
    ports: [4000],
    runtime: "node24",
  })
}

function hasHarnessInstructionDocument(context: AgentAdapterRunContext): boolean {
  return normalizeAgentWorkspaceSources(context.workspaceDefinition?.sources).some(source =>
    source.key === colocatedAgentInstructionsSourceKey
    && source.mountPath === ""
    && source.probeKeys?.includes("AGENTS.md"),
  )
}

async function resolveHarnessInstructions(context: AgentAdapterRunContext): Promise<string | undefined> {
  if (!context.workspace) return
  if (!hasHarnessInstructionDocument(context)) return
  if (!await context.workspace.fs.exists("AGENTS.md")) return
  const content = await context.workspace.fs.readFile("AGENTS.md")
  const document = await resolveColocatedAgentInstructionDocument(content, context.workspaceDefinition?.sourceRootDir)
  return document ? composeHarnessInstructions(document, context) : undefined
}

async function writeHarnessInstructionFiles(
  session: HarnessInstructionSandbox,
  sessionWorkDir: string,
  abortSignal: AbortSignal | undefined,
  instructions: string | undefined,
) {
  if (!instructions) return

  const bytes = new TextEncoder().encode(`${instructions}\n`)
  await Promise.all(harnessInstructionFiles.map(async file => {
    await session.writeBinaryFile({
      abortSignal,
      content: bytes,
      path: `${sessionWorkDir.replace(/\/+$/, "")}/${file}`,
    })
  }))
}

async function resolveHarness<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  harness: AgentHarnessDriverInput<TRuntimeConfig, CALL_OPTIONS>,
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
) {
  if (typeof harness === "function") {
    return await harness(toRunCallbackContext(context))
  }
  return harness
}

async function resolveHarnessSandboxProvider<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  harnessSandbox: AgentHarnessSandboxProviderInput<TRuntimeConfig, CALL_OPTIONS> | undefined,
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
): Promise<object | undefined> {
  const provider = typeof harnessSandbox === "function"
    ? await harnessSandbox(toRunCallbackContext(context))
    : harnessSandbox
  if (provider !== undefined && (!provider || typeof provider !== "object")) {
    throw new TypeError("[vitehub] defineAgent({ harnessSandbox }) must return a harness sandbox provider object.")
  }
  return provider
}

async function createHarnessAgent<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  options: HarnessAgentAdapterOptions<TRuntimeConfig, CALL_OPTIONS>,
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
  prepareWorkspaceSession: (session: unknown, sessionWorkDir: string, abortSignal: AbortSignal | undefined) => Promise<void>,
): Promise<HarnessAgentLike> {
  assertSupportedHarnessDriverContributions(context)
  const { HarnessAgent } = await import("@ai-sdk/harness/agent") as unknown as { HarnessAgent: HarnessAgentConstructor }
  const sandbox = context.harnessSandboxProvider ?? await resolveHarnessSandboxProvider(options.harnessSandbox, context) ?? await createDefaultHarnessSandbox(context)
  const harness = await resolveHarness(options.harness, context)
  const tools = toHarnessTools(context)
  return new HarnessAgent({
    harness,
    sandboxConfig: {
      onSession: async ({ abortSignal, session, sessionWorkDir }: { abortSignal?: AbortSignal, session: unknown, sessionWorkDir: string }) => {
        await prepareWorkspaceSession(session, sessionWorkDir, abortSignal)
      },
    },
    permissionMode: defaultHarnessPermissionMode(harness),
    sandbox,
    ...(tools ? { tools } : {}),
  })
}

function hasDetach(session: HarnessAgentSessionLike): session is HarnessAgentSessionLike & { detach: () => MaybePromise<unknown> } {
  return typeof session.detach === "function"
}

async function destroySession(session: HarnessAgentSessionLike) {
  await session.destroy()
}

function withCleanup<T>(iterable: AsyncIterable<T>, cleanup: (error?: unknown) => Promise<void>, abortSignal?: AbortSignal): AsyncIterable<T> {
  return (async function* () {
    const iterator = iterable[Symbol.asyncIterator]()
    let caught: unknown
    try {
      for (;;) {
        const result = await nextWithAbort(iterator.next(), abortSignal, "[vitehub] Harness Agent Driver stream aborted.")
        if (result.done) break
        yield result.value
      }
    }
    catch (error) {
      caught = error
      void iterator.return?.().catch(() => {})
      throw error
    }
    finally {
      await cleanup(caught)
    }
  })()
}

function withCleanupStream<T>(stream: ReadableStream<T>, cleanup: (error?: unknown) => Promise<void>): ReadableStream<T> {
  const reader = stream.getReader()
  let cleaned = false
  const cleanupOnce = async (error?: unknown) => {
    if (cleaned) return
    cleaned = true
    await cleanup(error)
  }
  return new ReadableStream<T>({
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      }
      finally {
        await cleanupOnce(reason)
      }
    },
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          await cleanupOnce()
          controller.close()
          return
        }
        controller.enqueue(result.value)
      }
      catch (error) {
        await cleanupOnce(error)
        controller.error(error)
      }
    },
  })
}

function wrapCleanupIterable<T>(iterable: AsyncIterable<T>, cleanup: (error?: unknown) => Promise<void>, abortSignal?: AbortSignal) {
  return withCleanup(iterable, cleanup, abortSignal)
}

async function withSessionCleanup(result: unknown, cleanup: (error?: unknown) => Promise<void>, abortSignal?: AbortSignal): Promise<unknown> {
  let cleanupCalled = false
  const cleanupOnce = async (error?: unknown) => {
    if (cleanupCalled) return
    cleanupCalled = true
    await cleanup(error)
  }

  if (isAsyncIterable(result)) {
    return withCleanup(result, cleanupOnce, abortSignal)
  }
  if (!result || typeof result !== "object") {
    await cleanupOnce()
    return result
  }

  const asyncIterableKeys = ["stream", "fullStream", "textStream"] as const
  const entries = asyncIterableKeys
    .map(key => [key, (result as Record<string, unknown>)[key]] as const)
    .filter((entry): entry is readonly [typeof asyncIterableKeys[number], AsyncIterable<unknown>] => isAsyncIterable(entry[1]))

  if (!entries.length) {
    await cleanupOnce()
    return result
  }

  const clone = Object.create(Object.getPrototypeOf(result)) as Record<string, unknown>
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(result))
  const wrappedIterables = new Map<AsyncIterable<unknown>, AsyncIterable<unknown>>()
  for (const [key, iterable] of entries) {
    let wrapped = wrappedIterables.get(iterable)
    if (!wrapped) {
      wrapped = wrapCleanupIterable(iterable, cleanupOnce, abortSignal)
      wrappedIterables.set(iterable, wrapped)
    }
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: wrapped,
    })
  }
  const toUIMessageStream = (result as { toUIMessageStream?: unknown }).toUIMessageStream
  if (typeof toUIMessageStream === "function") {
    Object.defineProperty(clone, "toUIMessageStream", {
      configurable: true,
      enumerable: false,
      value: (...args: unknown[]) => {
        try {
          const stream = toUIMessageStream.apply(result, args) as unknown
          return typeof stream === "object" && stream !== null && typeof (stream as ReadableStream<unknown>).getReader === "function"
            ? withCleanupStream(stream as ReadableStream<unknown>, cleanupOnce)
            : stream
        }
        catch (error) {
          void cleanupOnce(error)
          throw error
        }
      },
    })
  }
  Object.defineProperty(clone, Symbol.asyncIterator, {
    configurable: true,
    value: () => streamAgentOutputToEvents(clone)[Symbol.asyncIterator](),
  })
  return clone
}

function getResumeStates(options: object): Map<string, unknown> {
  const existing = harnessResumeStates.get(options)
  if (existing) return existing
  const states = new Map<string, unknown>()
  harnessResumeStates.set(options, states)
  return states
}

export function createHarnessAgentAdapter<
  CALL_OPTIONS = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
>(
  options: HarnessAgentAdapterOptions<TRuntimeConfig, CALL_OPTIONS>,
): AgentAdapter<CALL_OPTIONS, TRuntimeConfig> {
  const resumeStates = getResumeStates(options)
  const usageMetadata = createHarnessUsageMetadata(options.credentials)

  async function createSession(
    agent: HarnessAgentLike,
    context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
    getWorkspaceSession: () => { close: (error?: unknown) => MaybePromise<void> } | undefined,
  ) {
    const sessionId = await resolveHarnessSessionKey(options.sessionKey, context)
    const resumesSession = sessionId ? resumeStates.has(sessionId) : false
    const resumeFrom = sessionId ? resumeStates.get(sessionId) : undefined
    const sessionOptions = {
      ...(context.input.abortSignal ? { abortSignal: context.input.abortSignal } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(resumeFrom !== undefined ? { resumeFrom } : {}),
      ...(typeof context.input.timeout === "number" ? { timeout: context.input.timeout } : {}),
    }
    const session = await agent.createSession(Object.keys(sessionOptions).length ? sessionOptions : undefined)
    const cleanup = async (error?: unknown) => {
      let closeError = error
      try {
        await getWorkspaceSession()?.close(error)
      }
      catch (nextError) {
        closeError = nextError
      }
      if (!sessionId || closeError) {
        if (sessionId) resumeStates.delete(sessionId)
        await destroySession(session)
        if (closeError !== error) throw closeError
        return
      }
      if (!hasDetach(session)) {
        resumeStates.delete(sessionId)
        await destroySession(session)
        return
      }
      resumeStates.set(sessionId, await session.detach())
    }
    if (context.input.abortSignal?.aborted) {
      const error = context.input.abortSignal.reason || new Error("[vitehub] Harness Agent Driver session aborted.")
      await cleanup(error)
      throw error
    }
    return {
      cleanup,
      session,
      resumesSession,
    }
  }

  async function createAgentAndSession(context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>) {
    let workspaceSession: { close: (error?: unknown) => MaybePromise<void> } | undefined
    const agent = await createHarnessAgent(options, context, async (session, sessionWorkDir, abortSignal) => {
      if (!context.workspace) return
      const harnessInstructions = await resolveHarnessInstructions(context)
      const { prepareHarnessWorkspaceSession } = await import("@vite-hub/workspace")
      workspaceSession = await prepareHarnessWorkspaceSession(context.workspace, {
        abortSignal,
        ignoreWriteBackPaths: harnessInstructions ? harnessInstructionFiles : [],
        paths: selectedWorkspaceScopePaths(context),
        session: session as never,
        sessionWorkDir,
      })
      try {
        await writeHarnessInstructionFiles(session as HarnessInstructionSandbox, sessionWorkDir, abortSignal, harnessInstructions)
      }
      catch (error) {
        await workspaceSession.close(error)
        workspaceSession = undefined
        throw error
      }
    })
    return {
      agent,
      ...await createSession(agent, context, () => workspaceSession),
    }
  }

  return {
    async generate(context) {
      const { agent, cleanup, session, resumesSession } = await createAgentAndSession(context)
      try {
        const result = defineAgentUsageMetadata(await agent.generate({
          ...await toHarnessCallInput(context, resumesSession),
          session,
        }), usageMetadata)
        await cleanup()
        return result
      }
      catch (error) {
        await cleanup(error)
        throw error
      }
    },
    name: "ai-sdk-harness",
    async stream(context) {
      const { agent, cleanup, session, resumesSession } = await createAgentAndSession(context)
      try {
        const result = defineAgentUsageMetadata(await agent.stream({
          ...await toHarnessCallInput(context, resumesSession),
          session,
        }), usageMetadata)
        return await withSessionCleanup(result, cleanup, context.input.abortSignal)
      }
      catch (error) {
        await cleanup(error)
        throw error
      }
    },
  }
}
