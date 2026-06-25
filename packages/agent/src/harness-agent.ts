import {
  createHarnessUsageMetadata,
  defineAgentUsageMetadata,
} from "./internal/agent-usage-metadata.ts"
import { hasTrustedWorkspaceAccessScope } from "./access-runtime.ts"
import { nextWithAbort } from "./internal/abortable-stream.ts"
import { toAiSdkModelMessages } from "./ai-sdk.ts"
import { isAsyncIterable } from "./internal/stream-result.ts"

import type {
  AgentAdapter,
  AgentAdapterRunContext,
  AgentDriverContributionKind,
  AgentHarnessCredentialSource,
  AgentHarnessDriverInput,
  AgentHarnessSandboxInput,
  AgentHarnessSessionKey,
  AgentRunCallbackContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "./types.ts"

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

type HarnessAgentConstructor = new (settings: Record<string, unknown>) => HarnessAgentLike
const harnessResumeStates = new WeakMap<object, Map<string, unknown>>()

interface HarnessAgentAdapterOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  credentials?: AgentHarnessCredentialSource
  harness: AgentHarnessDriverInput<TRuntimeConfig, CALL_OPTIONS>
  sandbox?: AgentHarnessSandboxInput<TRuntimeConfig, CALL_OPTIONS>
  sessionKey?: AgentHarnessSessionKey<TRuntimeConfig, CALL_OPTIONS>
}

function hasEntries(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0
}

function unsupportedHarnessContributionKinds(context: AgentAdapterRunContext): Set<AgentDriverContributionKind> {
  const kinds = new Set<AgentDriverContributionKind>()
  if (hasEntries(context.tools)) kinds.add("Capability tools")
  if (context.providerTools?.length) kinds.add("provider tools")
  if (context.capabilityInstructions?.length) kinds.add("Capability instructions")
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
    unsupportedKinds.has("Capability tools") ? "Capability tools" : undefined,
    unsupportedKinds.has("provider tools") ? "provider tools" : undefined,
    unsupportedKinds.has("Capability instructions") ? "Capability instructions" : undefined,
  ].filter((value): value is string => Boolean(value))
}

function assertSupportedHarnessDriverContributions(context: AgentAdapterRunContext) {
  const unsupported = formatUnsupportedHarnessContributions(context)

  if (unsupported.length) {
    throw new Error(`[vitehub] Harness Agent Drivers do not support these Capability Driver Contributions yet: ${unsupported.join("; ")}. Move model-facing tools and instructions to harness-native workspace files or remove those capabilities for harness.`)
  }
}

function selectedWorkspaceScopePaths(context: AgentAdapterRunContext): string[] | undefined {
  if (!hasTrustedWorkspaceAccessScope(context.context)) return
  const scope = context.context.get("access")?.workspaceScope
  if (!scope || scope.all) return
  const paths = [...new Set([...scope.paths, ...(context.harnessWorkspacePaths || [])])]
  return paths.length ? paths : undefined
}

function toHarnessCallInput(context: AgentAdapterRunContext) {
  const base = {
    abortSignal: context.input.abortSignal,
    timeout: context.input.timeout,
    ...("options" in context.input ? { options: context.input.options } : {}),
  }

  if (context.messages.length) {
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

async function createDefaultHarnessSandbox() {
  let sandboxModule: { createVercelSandbox: (settings: Record<string, unknown>) => unknown }
  try {
    sandboxModule = await import("@ai-sdk/sandbox-vercel") as typeof sandboxModule
  }
  catch (error) {
    throw new Error("[vitehub] defineAgent({ driver: { harness } }) requires driver.sandbox or @ai-sdk/sandbox-vercel for the default harness sandbox.", { cause: error })
  }

  return sandboxModule.createVercelSandbox({
    ports: [4000],
    runtime: "node24",
  })
}

async function resolveHarnessSandbox<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  sandbox: AgentHarnessSandboxInput<TRuntimeConfig, CALL_OPTIONS> | undefined,
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
) {
  if (typeof sandbox === "function") {
    return await sandbox(toRunCallbackContext(context)) ?? await createDefaultHarnessSandbox()
  }
  return sandbox ?? await createDefaultHarnessSandbox()
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
  const sandbox = await resolveHarnessSandbox(options.sandbox, context)
  const harness = await resolveHarness(options.harness, context)
  return new HarnessAgent({
    harness,
    onSandboxSession: async ({ abortSignal, session, sessionWorkDir }: { abortSignal?: AbortSignal, session: unknown, sessionWorkDir: string }) => {
      await prepareWorkspaceSession(session, sessionWorkDir, abortSignal)
    },
    permissionMode: "allow-all",
    sandbox,
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
  for (const [key, iterable] of entries) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: withCleanup(iterable, cleanupOnce, abortSignal),
    })
  }
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
    return {
      cleanup,
      session,
    }
  }

  async function createAgentAndSession(context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>) {
    let workspaceSession: { close: (error?: unknown) => MaybePromise<void> } | undefined
    const agent = await createHarnessAgent(options, context, async (session, sessionWorkDir, abortSignal) => {
      if (!context.workspace) return
      const { prepareHarnessWorkspaceSession } = await import("@vite-hub/workspace")
      workspaceSession = await prepareHarnessWorkspaceSession(context.workspace, {
        abortSignal,
        paths: selectedWorkspaceScopePaths(context),
        session: session as never,
        sessionWorkDir,
      })
    })
    return {
      agent,
      ...await createSession(agent, context, () => workspaceSession),
    }
  }

  return {
    async generate(context) {
      const { agent, cleanup, session } = await createAgentAndSession(context)
      try {
        const result = defineAgentUsageMetadata(await agent.generate({
          ...toHarnessCallInput(context),
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
      const { agent, cleanup, session } = await createAgentAndSession(context)
      try {
        const result = defineAgentUsageMetadata(await agent.stream({
          ...toHarnessCallInput(context),
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
