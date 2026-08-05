import { normalizeWorkspaceSourcesMetadata } from "@vite-hub/workspace/source-metadata"

import {
  createHarnessUsageMetadata,
  defineAgentUsageMetadata,
} from "./internal/agent-usage-metadata.ts"
import { hasTrustedWorkspaceAccessScope } from "./access-runtime.ts"
import { streamAgentOutputToEvents } from "./agent-output.ts"
import {
  setActiveHarnessWorkspaceFiles,
  setHarnessWorkspaceDiff,
} from "./harness-runtime.ts"
import { composeInstructionDocument } from "./instruction-composition.ts"
import { agentInvocationSourceContext } from "./invocation-context.ts"
import {
  colocatedAgentInstructionsSourceKey,
  resolveColocatedAgentInstructionDocument,
  workspaceDefinitionWithAutoCommitRules,
} from "./workspace-agent.ts"
import { abortSignalError, nextWithAbort } from "./internal/abortable-stream.ts"
import { agentOutputInstructions } from "./internal/agent-structured-output.ts"
import { markMessageChannelInstructionConsumer, resolveMessageChannelInstructions } from "./internal/channels.ts"
import {
  colocatedAgentSkillsContextKey,
  type ColocatedAgentSkills,
} from "./internal/colocated-agent-skills.ts"
import { toAiSdkModelMessages } from "./ai-sdk.ts"
import { attachmentStringBytes, isAttachmentData, isAttachmentPart, isTextAttachmentMediaType, resolveAttachmentData } from "./messages.ts"
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
  AgentHarnessInstructions,
  AgentHarnessSandboxProviderInput,
  AgentHarnessSessionKey,
  AgentHarnessWorkDir,
  AgentRunCallbackContext,
  AgentRuntimeConfig,
  AgentToolSet,
  AgentWaitUntil,
  MaybePromise,
} from "./types.ts"
import type { AttachmentData, Message } from "./messages.ts"
import type { UserContent, UserModelMessage } from "ai"

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

type HarnessWorkspaceMaterializationContext = AgentAdapterRunContext & {
  workspaceMaterializationPaths?: readonly string[]
}

type HarnessInstructionSandbox = {
  writeBinaryFile(options: { abortSignal?: AbortSignal, content: Uint8Array, path: string }): MaybePromise<void>
}

type HarnessFileSandbox = {
  readBinaryFile?(options: { abortSignal?: AbortSignal, path: string }): MaybePromise<Uint8Array | null>
}

type HarnessGlobalSkillsSandbox = {
  run(options: { abortSignal?: AbortSignal, command: string, env?: Record<string, string>, workingDirectory?: string }): PromiseLike<{ exitCode: number, stderr?: string, stdout?: string }>
}

type HarnessAttachmentSandbox = HarnessInstructionSandbox & HarnessGlobalSkillsSandbox & {
  [harnessRemoveDirectory]?: (directory: string) => MaybePromise<void>
}

interface HarnessPreparedSandbox {
  abortSignal?: AbortSignal
  session: HarnessAttachmentSandbox
  sessionWorkDir: string
}

type HarnessAgentConstructor = new (settings: Record<string, unknown>) => HarnessAgentLike
const harnessResumeStates = new WeakMap<object, Map<string, unknown>>()
const harnessGeneratedFiles = ["harness-tool.mjs"] as const
const harnessInstructionFiles = ["AGENTS.md", "CLAUDE.md"] as const
const harnessAttachmentDirectory = ".vitehub/attachments"
const harnessAttachmentMaxBytes = 25 * 1024 * 1024
const harnessAgentPackage = "@ai-sdk/harness/agent"
const harnessRemoveDirectory = Symbol.for("vitehub.harnessRemoveDirectory")
const harnessSandboxAdapter = Symbol.for("vitehub.harnessSandboxAdapter")
const harnessInvocationSandboxAdapter = Symbol.for("vitehub.harnessInvocationSandboxAdapter")
const harnessGlobalSkillsDirectory = Symbol.for("vitehub.harnessGlobalSkillsDirectory")
const harnessSessionPrepare = Symbol.for("vitehub.harnessSessionPrepare")

function isHarnessRelativeDirectory(value: unknown): value is string {
  return typeof value === "string"
    && value !== "."
    && posix.normalize(value) === value
    && !posix.isAbsolute(value)
    && !value.split("/").includes("..")
}

interface HarnessAgentAdapterOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  credentials?: AgentHarnessCredentialSource
  harness: AgentHarnessDriverInput<TRuntimeConfig, CALL_OPTIONS>
  instructions?: AgentHarnessInstructions<TRuntimeConfig, CALL_OPTIONS>
  sandbox?: AgentHarnessSandboxProviderInput<TRuntimeConfig, CALL_OPTIONS>
  sessionKey?: AgentHarnessSessionKey<TRuntimeConfig, CALL_OPTIONS>
  workDir?: AgentHarnessWorkDir<TRuntimeConfig, CALL_OPTIONS>
}

interface HarnessSessionIdentity {
  box?: {
    identity: string
    runtime: string
    workspace?: string
  }
  instructions?: string
  workDir?: string
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
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/")
  const wildcard = normalizedPattern.search(/[*{[(?]/)
  if (wildcard === 0 && normalizedPattern !== "**" && !normalizedPattern.startsWith("**/")) return
  const base = wildcard === -1 ? normalizedPattern : normalizedPattern.slice(0, wildcard)
  const normalized = base.replace(/\/+$/, "")
  const parts = normalized.split("/").filter(Boolean)
  if (parts.some(part => part === "." || part === "..")) return
  return normalized
}

function workspaceRuleHarnessPaths(definition: AgentAdapterRunContext["workspaceDefinition"]): string[] {
  if (!definition) return []
  const rules = [
    ...Object.entries(definition.rules || {}),
    ...(definition.plugins || []).flatMap(plugin => Object.entries(plugin.rules || {})),
  ]
  return rules.flatMap(([pattern, rule]) => rule.write ? [staticWorkspaceRulePath(pattern)].filter((path): path is string => path !== undefined) : [])
}

function hasWorkspaceCommitRules(definition: AgentAdapterRunContext["workspaceDefinition"]): boolean {
  return definition?.commit === true
    || typeof definition?.commit === "string"
    || [
      ...Object.values(definition?.rules || {}),
      ...(definition?.plugins || []).flatMap(plugin => Object.values(plugin.rules || {})),
    ].some(rule => rule.commit !== undefined)
}

function workspaceSourceHarnessPaths(context: AgentAdapterRunContext): string[] {
  const sources = context.workspaceDefinition?.sources
  if (!sources) return []
  return normalizeWorkspaceSourcesMetadata(sources).flatMap((source) => {
    if (source.materialize === "lazy" && !source.requestOnly) {
      return [source.mountPath]
    }
    if (source.probeKeys?.length) {
      return source.probeKeys.map(key => [source.mountPath, key].filter(Boolean).join("/"))
    }
    return []
  })
}

function hasLazyWorkspaceSources(context: AgentAdapterRunContext): boolean {
  const sources = context.workspaceDefinition?.sources
  if (!sources) return false
  return normalizeWorkspaceSourcesMetadata(sources).some((source) => {
    return source.materialize === "lazy"
  })
}

function pathContains(container: string, path: string): boolean {
  return !container || path === container || path.startsWith(`${container}/`)
}

function normalizeActiveHarnessWorkspacePath(sessionWorkDir: string, path: string): string {
  const normalizedWorkDir = sessionWorkDir.replace(/\\/g, "/").replace(/\/+$/g, "").replace(/\/+/g, "/")
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+/g, "/")
  const stripped = normalizedPath.startsWith(`${normalizedWorkDir}/`) || normalizedPath === normalizedWorkDir
    ? normalizedPath.slice(normalizedWorkDir.length)
    : normalizedPath.replace(/^\/workspace(?:\/|$)/, "")
  const workspacePath = stripped.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/")
  const parts = workspacePath.split("/").filter(Boolean)
  if (parts.some(part => part === "." || part === "..")) {
    throw new Error(`[vitehub] Workspace path must stay inside the workspace: "${path}".`)
  }
  return parts.join("/")
}

function joinHarnessSessionPath(sessionWorkDir: string, workspacePath: string): string {
  return [sessionWorkDir.replace(/\/+$/, ""), workspacePath].filter(Boolean).join("/")
}

function activeHarnessWorkspaceFiles(session: HarnessFileSandbox, sessionWorkDir: string, abortSignal: AbortSignal | undefined) {
  if (!session.readBinaryFile) return
  return {
    async readFile(path: string) {
      const workspacePath = normalizeActiveHarnessWorkspacePath(sessionWorkDir, path)
      if (!workspacePath) return { active: true as const, body: undefined }
      const body = await session.readBinaryFile?.({
        abortSignal,
        path: joinHarnessSessionPath(sessionWorkDir, workspacePath),
      }) ?? undefined
      return { active: true as const, body }
    },
  }
}

function compactWorkspacePaths(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort((left, right) => left.length - right.length || left.localeCompare(right))
  return sorted.filter((path, index) => !sorted.some((candidate, candidateIndex) => candidateIndex < index && pathContains(candidate, path)))
}

function harnessSupportWorkspacePaths(context: AgentAdapterRunContext, definition = context.workspaceDefinition): string[] {
  const materializationContext = context as HarnessWorkspaceMaterializationContext
  return compactWorkspacePaths([
    ...(definition?.commit === true || typeof definition?.commit === "string" ? [""] : []),
    ...(materializationContext.workspaceMaterializationPaths || []),
    ...workspaceRuleHarnessPaths(definition),
  ])
}

function withHarnessInstructionPaths(paths: readonly string[], includeEmpty = false): string[] {
  return paths.length || includeEmpty ? compactWorkspacePaths([...harnessInstructionFiles, ...paths]) : []
}

function explicitHarnessWorkspacePaths(context: AgentAdapterRunContext, definition = context.workspaceDefinition): string[] {
  return withHarnessInstructionPaths([
    ...harnessSupportWorkspacePaths(context, definition),
    ...workspaceSourceHarnessPaths(context),
  ], hasLazyWorkspaceSources(context))
}

function selectedWorkspaceScopePaths(context: AgentAdapterRunContext, definition = context.workspaceDefinition): string[] | undefined {
  const harnessPaths = explicitHarnessWorkspacePaths(context, definition)
  if (!hasTrustedWorkspaceAccessScope(context.context)) return harnessPaths.length ? harnessPaths : undefined
  const scope = context.context.get("access")?.workspaceScope
  if (!scope) return harnessPaths.length ? harnessPaths : undefined
  if (scope.all) return [""]
  const paths = [...new Set([...(scope.paths || []), ...harnessSupportWorkspacePaths(context, definition).filter(path => path !== "")])]
  return paths.length ? withHarnessInstructionPaths(paths) : []
}

async function composeHarnessInstructions(content: string, context: AgentAdapterRunContext) {
  const compositionContext = { context: context.context.toJSON(), workspace: context.workspaceInstructionBindings }
  return await composeInstructionDocument(content, compositionContext)
}

function harnessSerializableMessages(messages: Message[]): Message[] {
  return messages.map(message => ({
    ...message,
    parts: message.parts.flatMap((part) => {
      if (!isAttachmentPart(part) || (!part.fetchData && !(part.data instanceof Blob))) return [part]
      const { fetchData: _fetchData, ...reference } = part
      if (reference.data instanceof Blob) delete reference.data
      return reference.data || reference.url ? [reference] : []
    }),
  }))
}

type HarnessProjectedContentPart = Exclude<UserContent, string>[number]

function projectHarnessChatMessages(messages: Message[]): UserModelMessage {
  const modelMessages = toAiSdkModelMessages(messages)
  const lastUserMessage = modelMessages.findLast((message): message is UserModelMessage => message.role === "user")
  if (!lastUserMessage) {
    throw new Error("[vitehub] Harness chat history must contain a user message.")
  }
  if (messages.length === 1) return lastUserMessage

  const content: HarnessProjectedContentPart[] = []
  for (const message of modelMessages) {
    const projected: HarnessProjectedContentPart[] = []
    if (typeof message.content === "string") {
      projected.push({ text: message.content, type: "text" })
    }
    else {
      for (const part of message.content) {
        if (part.type === "text") {
          projected.push({ text: part.text, type: "text" })
        }
        else if (message.role === "user" && part.type === "image") {
          projected.push(part)
        }
        else {
          projected.push({ text: JSON.stringify(part), type: "text" })
        }
      }
    }
    if (!projected.length) continue
    content.push({ text: `<message role="${message.role}">\n`, type: "text" })
    content.push(...projected)
    content.push({ text: "\n</message>\n", type: "text" })
  }
  return { content, role: "user" }
}

function latestHarnessUserMessage(messages: Message[]): Message[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === "user") return [message]
  }
  return messages.slice(-1)
}

function harnessAttachmentExtension(mediaType: string): string {
  return {
    "application/pdf": "pdf",
    "image/apng": "apng",
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "text/plain": "txt",
  }[mediaType.toLowerCase()] || "bin"
}

function assertHarnessAttachmentSize(byteLength: number, remainingBytes: number, type: string): void {
  if (byteLength > remainingBytes) {
    throw new Error(`[vitehub] ${type} attachment is ${byteLength} bytes, which exceeds the remaining Harness attachment limit (${remainingBytes} bytes).`)
  }
}

function harnessBase64ByteLength(value: string): number {
  let encodedCharacters = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 61) break
    if (
      (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || code === 43
      || code === 45
      || code === 47
      || code === 95
    ) {
      encodedCharacters++
    }
  }
  return Math.floor(encodedCharacters * 6 / 8)
}

function harnessAttachmentStringBytes(value: string, mediaType: string, remainingBytes: number, type: string): Uint8Array {
  const dataUrl = /^data:([^,]*?),(.*)$/is.exec(value)
  if (dataUrl) {
    const encoded = dataUrl[2]!
    if (dataUrl[1]!.split(";").some(parameter => parameter.toLowerCase() === "base64")) {
      assertHarnessAttachmentSize(harnessBase64ByteLength(encoded), remainingBytes, type)
      return attachmentStringBytes(value, mediaType)
    }
    if (encoded.length > remainingBytes * 3) {
      assertHarnessAttachmentSize(Math.ceil(encoded.length / 3), remainingBytes, type)
    }
    const bytes = attachmentStringBytes(value, mediaType)
    assertHarnessAttachmentSize(bytes.byteLength, remainingBytes, type)
    return bytes
  }
  if (!isTextAttachmentMediaType(mediaType)) {
    assertHarnessAttachmentSize(harnessBase64ByteLength(value), remainingBytes, type)
  }
  else {
    assertHarnessAttachmentSize(Buffer.byteLength(value), remainingBytes, type)
  }
  const bytes = attachmentStringBytes(value, mediaType)
  assertHarnessAttachmentSize(bytes.byteLength, remainingBytes, type)
  return bytes
}

async function harnessAttachmentBytes(data: AttachmentData, mediaType: string, remainingBytes: number, type: string): Promise<Uint8Array> {
  if (data instanceof Blob) {
    assertHarnessAttachmentSize(data.size, remainingBytes, type)
    return new Uint8Array(await data.arrayBuffer())
  }
  if (data instanceof ArrayBuffer) {
    assertHarnessAttachmentSize(data.byteLength, remainingBytes, type)
    return new Uint8Array(data)
  }
  if (data instanceof Uint8Array) {
    assertHarnessAttachmentSize(data.byteLength, remainingBytes, type)
    return data
  }
  return harnessAttachmentStringBytes(data, mediaType, remainingBytes, type)
}

async function resolveHarnessAttachmentData(
  part: Extract<Message["parts"][number], { type: "audio" | "file" | "image" }>,
  abortSignal?: AbortSignal,
): Promise<AttachmentData | undefined> {
  if (abortSignal?.aborted) {
    throw abortSignalError(abortSignal, "[vitehub] Harness attachment resolution aborted.")
  }
  const fetchedPromise = resolveAttachmentData(part)
  const fetched = abortSignal
    ? await new Promise<AttachmentData | undefined>((resolve, reject) => {
        const onAbort = () => {
          abortSignal.removeEventListener("abort", onAbort)
          reject(abortSignalError(abortSignal, "[vitehub] Harness attachment resolution aborted."))
        }
        if (abortSignal.aborted) return onAbort()
        abortSignal.addEventListener("abort", onAbort, { once: true })
        fetchedPromise.then(resolve, reject).finally(() => abortSignal.removeEventListener("abort", onAbort))
      })
    : await fetchedPromise
  return isAttachmentData(fetched) ? fetched : undefined
}

async function removeHarnessAttachmentDirectory(session: HarnessAttachmentSandbox, directory: string): Promise<void> {
  const removeDirectory = session[harnessRemoveDirectory]
  if (!removeDirectory) throw new Error("[vitehub] Harness attachment materialization requires sandbox directory removal support.")
  await removeDirectory.call(session, directory)
}

async function materializeHarnessChatMessages(
  messages: Message[],
  prepared: HarnessPreparedSandbox,
): Promise<{ directory?: string, messages: Message[] }> {
  const hasAttachments = messages.some(message =>
    message.role === "user" && message.parts.some(isAttachmentPart),
  )
  if (!hasAttachments) return { messages }
  if (!prepared.session[harnessRemoveDirectory]) {
    throw new Error("[vitehub] Harness attachment materialization requires sandbox directory removal support.")
  }

  let remainingBytes = harnessAttachmentMaxBytes
  const directory = joinHarnessSessionPath(
    prepared.sessionWorkDir,
    `${harnessAttachmentDirectory}/${globalThis.crypto.randomUUID()}`,
  )
  try {
    const materialized: Message[] = []
    for (const [messageIndex, message] of messages.entries()) {
      if (message.role !== "user") {
        materialized.push(message)
        continue
      }
      const parts: Message["parts"] = []
      for (const [partIndex, part] of message.parts.entries()) {
        if (!isAttachmentPart(part)) {
          parts.push(part)
          continue
        }
        const data = await resolveHarnessAttachmentData(part, prepared.abortSignal)
        if (!data) {
          if (part.url) {
            throw new Error(`[vitehub] Harness ${part.type} attachment requires data or fetchData(); URL-only attachments must be resolved by the Channel adapter.`)
          }
          throw new TypeError(`[vitehub] Harness ${part.type} attachment fetchData() did not return supported attachment data.`)
        }
        const bytes = await harnessAttachmentBytes(data, part.mediaType, remainingBytes, part.type)
        assertHarnessAttachmentSize(bytes.byteLength, remainingBytes, part.type)
        remainingBytes -= bytes.byteLength
        const path = `${directory}/message-${messageIndex + 1}-attachment-${partIndex + 1}.${harnessAttachmentExtension(part.mediaType)}`
        await prepared.session.writeBinaryFile({
          abortSignal: prepared.abortSignal,
          content: bytes,
          path,
        })
        if (part.type === "image") {
          const { fetchData: _fetchData, url: _url, ...image } = part
          parts.push({ ...image, data: path })
        }
        else {
          parts.push({
            id: part.id,
            text: `Attachment ${JSON.stringify(part.name || part.type)} (${JSON.stringify(part.mediaType)}) is available at ${path}.`,
            type: "text" as const,
          })
        }
      }
      materialized.push({ ...message, parts })
    }
    return { directory, messages: materialized }
  }
  catch (error) {
    try {
      await removeHarnessAttachmentDirectory(prepared.session, directory)
    }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "[vitehub] Harness attachment preparation and cleanup failed.")
    }
    throw error
  }
}

async function prepareHarnessChatPrompt(
  context: AgentAdapterRunContext,
  resumesSession: boolean,
  prepared: HarnessPreparedSandbox | undefined,
): Promise<{ directory?: string, prompt: UserModelMessage }> {
  const selectedMessages = resumesSession ? latestHarnessUserMessage(context.messages) : context.messages
  const hasAttachments = selectedMessages.some(message => message.role === "user" && message.parts.some(isAttachmentPart))
  if (hasAttachments && !prepared) {
    throw new Error("[vitehub] Harness attachment materialization requires a prepared sandbox session.")
  }
  const materialized = prepared
    ? await materializeHarnessChatMessages(selectedMessages, prepared)
    : { messages: selectedMessages }
  try {
    return {
      ...(materialized.directory ? { directory: materialized.directory } : {}),
      prompt: projectHarnessChatMessages(materialized.messages),
    }
  }
  catch (error) {
    if (materialized.directory && prepared) {
      try {
        await removeHarnessAttachmentDirectory(prepared.session, materialized.directory)
      }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "[vitehub] Harness chat projection and attachment cleanup failed.")
      }
    }
    throw error
  }
}

async function toHarnessCallInput(
  context: AgentAdapterRunContext,
  resumesSession = false,
  chatPrompt?: UserModelMessage,
) {
  const base = {
    abortSignal: context.input.abortSignal,
    timeout: context.input.timeout,
    ...("options" in context.input ? { options: context.input.options } : {}),
  }

  if (context.messages.length) {
    if (context.context.has("chat")) {
      return {
        ...base,
        messages: [chatPrompt || projectHarnessChatMessages(resumesSession ? latestHarnessUserMessage(context.messages) : context.messages)],
      }
    }
    return {
      ...base,
      messages: toAiSdkModelMessages(harnessSerializableMessages(context.messages)),
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
    context.toolStepReporter,
  )
}

function harnessWriteBackIgnorePaths(context: AgentAdapterRunContext, instructions: string | undefined): string[] {
  const colocatedSkills = context.context.get<ColocatedAgentSkills>(colocatedAgentSkillsContextKey)
  const colocatedSkillDirectories = new Set(Object.values(colocatedSkills || {}).flatMap((source) => {
    if (!source || typeof source !== "object" || !("workspacePath" in source) || typeof source.workspacePath !== "string") return []
    const [root, skill] = source.workspacePath.split("/")
    return root === "skills" && skill ? [`${root}/${skill}`] : []
  }))
  return [
    ...(hasEntries(context.tools) ? harnessGeneratedFiles : []),
    ...(instructions ? harnessInstructionFiles : []),
    ...colocatedSkillDirectories,
  ]
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

async function resolveHarnessDriverInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  instructions: AgentHarnessInstructions<TRuntimeConfig, CALL_OPTIONS> | undefined,
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
): Promise<string | undefined> {
  const resolved = typeof instructions === "function"
    ? await instructions(toRunCallbackContext(context))
    : instructions
  if (resolved !== undefined && typeof resolved !== "string") {
    throw new TypeError("[vitehub] defineAgent({ driver.instructions }) must resolve to a string.")
  }
  const configured = resolved ? await composeHarnessInstructions(resolved, context) : undefined
  return [
    configured,
    resolveMessageChannelInstructions(context.context, context),
    agentOutputInstructions(context.output),
  ].filter(Boolean).join("\n\n") || undefined
}

async function resolveHarnessWorkDir<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  workDir: AgentHarnessWorkDir<TRuntimeConfig, CALL_OPTIONS> | undefined,
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
): Promise<string | undefined> {
  const resolved = typeof workDir === "function"
    ? await workDir(toRunCallbackContext(context))
    : workDir
  if (
    resolved !== undefined
    && (
      typeof resolved !== "string"
      || !resolved.trim()
      || resolved.startsWith("/")
      || resolved.includes("\\")
      || resolved.split("/").includes("..")
    )
  ) {
    throw new TypeError("[vitehub] defineAgent({ driver.workDir }) must resolve to a non-empty relative POSIX path inside the sandbox default working directory.")
  }
  return resolved
}

function isProcesslessHarnessRuntime(context: AgentAdapterRunContext): boolean {
  return context.runtime.runtime === "cloudflare-agents" || context.runtime.runtime === "deno"
}

function assertHarnessSandboxRuntime(sandbox: object, context: AgentAdapterRunContext): void {
  if (isProcesslessHarnessRuntime(context) && (sandbox as { providerId?: unknown }).providerId === "local") {
    throw new Error(`[vitehub] Harness Agent Drivers on ${context.runtime.runtime} require a process-capable driver.sandbox provider.`)
  }
}

const defaultHarnessEnvKeys = ["ComSpec", "HOME", "Path", "PATH", "PATHEXT", "SHELL", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USER"] as const

function defaultHarnessEnv(): Record<string, string> {
  return Object.fromEntries(defaultHarnessEnvKeys
    .map(key => [key, process.env[key]])
    .filter((entry): entry is [string, string] => entry[1] !== undefined))
}

async function createDefaultHarnessSandbox(context: AgentAdapterRunContext): Promise<object> {
  if (isProcesslessHarnessRuntime(context)) {
    throw new Error(`[vitehub] Harness Agent Drivers on ${context.runtime.runtime} require a process-capable driver.sandbox provider.`)
  }
  const { createLocalHarnessSandbox } = await import("./harness/local-sandbox.ts")
  return createLocalHarnessSandbox({ env: defaultHarnessEnv() })
}

function hasHarnessInstructionDocument(context: AgentAdapterRunContext): boolean {
  return normalizeWorkspaceSourcesMetadata(context.workspaceDefinition?.sources).some(source =>
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

function resolveHarnessGlobalSkillsDirectory(
  harness: object,
  context: AgentAdapterRunContext,
  invocation: { id: string, isolateBoxHome: boolean },
): unknown {
  const directory = (harness as Record<PropertyKey, unknown>)[harnessGlobalSkillsDirectory]
  return typeof directory === "function"
    ? (directory as (context: AgentAdapterRunContext, invocation: { id: string, isolateBoxHome: boolean }) => unknown)(context, invocation)
    : directory
}

async function resolveHarnessSandboxProvider<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  sandbox: AgentHarnessSandboxProviderInput<TRuntimeConfig, CALL_OPTIONS> | undefined,
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
): Promise<object | undefined> {
  const provider = typeof sandbox === "function"
    ? await sandbox(toRunCallbackContext(context))
    : sandbox
  if (provider !== undefined && (!provider || typeof provider !== "object")) {
    throw new TypeError("[vitehub] defineAgent({ driver.sandbox }) must return a harness sandbox provider object.")
  }
  return provider
}

async function createHarnessAgent<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  options: HarnessAgentAdapterOptions<TRuntimeConfig, CALL_OPTIONS>,
  context: AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig>,
  invocation: { id: string, isolateBoxHome: boolean },
  prepareWorkspaceSession: (
    session: unknown,
    sessionWorkDir: string,
    abortSignal: AbortSignal | undefined,
    globalSkillsDirectory: unknown,
    globalSkillsWorkspace: Awaited<ReturnType<typeof resolveHarnessGlobalSkills>>,
    sessionPrepare: unknown,
  ) => Promise<void>,
): Promise<{ agent: HarnessAgentLike, instructions?: string, workDir?: string }> {
  assertSupportedHarnessDriverContributions(context)
  const { HarnessAgent } = await import(/* @vite-ignore */ harnessAgentPackage) as unknown as { HarnessAgent: HarnessAgentConstructor }
  const harness = await resolveHarness(options.harness, context)
  const globalSkillsDirectory = resolveHarnessGlobalSkillsDirectory(harness, context, invocation)
  if (context.globalSkills?.length && !isHarnessRelativeDirectory(globalSkillsDirectory)) {
    throw new Error("[vitehub] This Harness Agent Driver does not support skills({ scope: \"global\" }).")
  }
  const globalSkillsWorkspace = await resolveHarnessGlobalSkills(context)
  const driverSandbox = context.harnessSandboxProvider === undefined
    ? await resolveHarnessSandboxProvider(options.sandbox, context)
    : undefined
  const defaultSandbox = context.harnessSandboxProvider === undefined && driverSandbox === undefined
  const baseSandbox = context.harnessSandboxProvider ?? driverSandbox ?? await createDefaultHarnessSandbox(context)
  assertHarnessSandboxRuntime(baseSandbox, context)
  const adaptInvocationSandbox = (harness as Record<PropertyKey, unknown>)[harnessInvocationSandboxAdapter]
  const adaptSandbox = (harness as Record<PropertyKey, unknown>)[harnessSandboxAdapter]
  let sandbox = baseSandbox
  if (typeof adaptInvocationSandbox === "function") {
    sandbox = (adaptInvocationSandbox as (provider: object, options: { box: boolean, defaultSandbox: boolean, invocation: { id: string, isolateBoxHome: boolean } }) => object)(baseSandbox, {
      box: Boolean(context.box),
      defaultSandbox,
      invocation,
    })
  }
  else if (typeof adaptSandbox === "function") {
    sandbox = (adaptSandbox as (provider: object, options: { box: boolean, defaultSandbox: boolean }) => object)(baseSandbox, {
      box: Boolean(context.box),
      defaultSandbox,
    })
  }
  else if (defaultSandbox && (harness as { harnessId?: unknown }).harnessId === "codex") {
    const { adaptCodexHarnessSandbox } = await import("./internal/codex-sandbox.ts")
    sandbox = adaptCodexHarnessSandbox(baseSandbox, { defaultSandbox: true, isolateHome: false })!
  }
  else if (defaultSandbox) {
    const bootstrap = await (harness as { getBootstrap?: () => Promise<{ bootstrapDir?: string }> }).getBootstrap?.()
    if (bootstrap?.bootstrapDir) {
      const { adaptLocalHarnessSandbox } = await import("./internal/local-sandbox.ts")
      sandbox = adaptLocalHarnessSandbox(baseSandbox, bootstrap.bootstrapDir)!
    }
  }
  const instructions = await resolveHarnessDriverInstructions(options.instructions, context)
  const workDir = await resolveHarnessWorkDir(options.workDir, context) ?? context.harnessWorkDir
  const tools = toHarnessTools(context)
  const agent = new HarnessAgent({
    harness,
    ...(instructions ? { instructions } : {}),
    sandboxConfig: {
      ...(workDir !== undefined ? { workDir } : {}),
      onSession: async ({ abortSignal, session, sessionWorkDir }: { abortSignal?: AbortSignal, session: unknown, sessionWorkDir: string }) => {
        setActiveHarnessWorkspaceFiles(context.context, activeHarnessWorkspaceFiles(session as HarnessFileSandbox, sessionWorkDir, abortSignal))
        await prepareWorkspaceSession(
          session,
          sessionWorkDir,
          abortSignal,
          globalSkillsDirectory,
          globalSkillsWorkspace,
          (harness as Record<PropertyKey, unknown>)[harnessSessionPrepare],
        )
      },
    },
    permissionMode: defaultHarnessPermissionMode(harness),
    sandbox,
    ...(tools ? { tools } : {}),
  })
  return { agent, instructions, workDir }
}

async function resolveHarnessGlobalSkills(
  context: AgentAdapterRunContext,
) {
  const skills = context.globalSkills || []
  if (!skills.length) return
  const { useWorkspace } = await import("@vite-hub/workspace")
  const { resolveWorkspaceSources } = await import("@vite-hub/workspace/runtime")
  const definition = await resolveWorkspaceSources({
    name: "__vitehub_global_skills",
    sources: Object.fromEntries(skills.map(skill => [skill.sourceKey, skill.source])),
    store: { provider: "memory" },
  }, {
    invocation: {
      context: agentInvocationSourceContext(context.context),
      run: context.runtime.run,
    },
  })
  const workspaceOptions = {
    definition,
    mode: "read" as const,
  }
  const workspace = useWorkspace("__vitehub_global_skills", workspaceOptions)
  for (const skill of skills) {
    if (!await workspace.fs.exists(`${skill.path}/SKILL.md`)) {
      throw new Error(`[vitehub] Global Skill source must contain ${skill.path}/SKILL.md.`)
    }
  }
  return { paths: skills.map(skill => skill.path), workspace }
}

async function resolveHarnessColocatedSkills(context: AgentAdapterRunContext, workspaceName: string) {
  const sources = context.context.get<ColocatedAgentSkills>(colocatedAgentSkillsContextKey)
  if (!sources || !Object.keys(sources).length) return
  const definition = {
    name: workspaceName,
    sources,
    store: { provider: "memory" as const },
  }
  const workspaceOptions = {
    definition,
    mode: "read" as const,
  }
  const { useWorkspace } = await import("@vite-hub/workspace")
  return useWorkspace(workspaceName, workspaceOptions)
}

async function prepareHarnessColocatedSkills(
  workspace: Awaited<ReturnType<typeof resolveHarnessColocatedSkills>>,
  session: unknown,
  destination: string,
  target: "." | "skills",
  abortSignal?: AbortSignal,
  refresh = false,
  workingDirectory = destination,
  stagingDirectoryName = ".vitehub-agent-skills",
): Promise<boolean> {
  if (!workspace) return false
  const { prepareHarnessWorkspaceSession } = await import("@vite-hub/workspace")
  const stagingDirectory = `${destination.replace(/\/+$/, "")}/${stagingDirectoryName}`
  let prepared: Awaited<ReturnType<typeof prepareHarnessWorkspaceSession>> | undefined
  try {
    prepared = await prepareHarnessWorkspaceSession(workspace, {
      abortSignal,
      paths: ["skills"],
      session: session as never,
      sessionWorkDir: stagingDirectory,
    })
    const refreshCommand = refresh
      ? `manifest=${target}/.vitehub-colocated && if [ -f "$manifest" ]; then while IFS= read -r managed || [ -n "$managed" ]; do case "$managed" in ''|*/*|.. ) exit 1 ;; esac; rm -rf -- ${target}/"$managed"; done < "$manifest"; fi && : > "$manifest" && find ${stagingDirectoryName}/skills -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; >> "$manifest" && `
      : ""
    const result = await (session as HarnessGlobalSkillsSandbox).run({
      abortSignal,
      command: `find ${stagingDirectoryName}/skills -type f -path "*/scripts/*" -exec chmod +x {} + && mkdir -p ${target} && ${refreshCommand}cp -Rn ${stagingDirectoryName}/skills/. ${target} && rm -rf ${stagingDirectoryName}`,
      workingDirectory,
    })
    if (result.exitCode !== 0) throw new Error(result.stderr || "sandbox command failed")
  }
  catch (error) {
    try {
      await (session as HarnessGlobalSkillsSandbox).run({
        command: `rm -rf -- ${stagingDirectoryName}`,
        workingDirectory,
      })
    }
    catch {}
    await prepared?.close(error)
    throw new Error(`[vitehub] Failed to install colocated Agent Skills: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  await prepared.close()
  return true
}

async function prepareHarnessGlobalSkills(
  resolved: Awaited<ReturnType<typeof resolveHarnessGlobalSkills>>,
  session: unknown,
  directory: unknown,
  abortSignal?: AbortSignal,
  workingDirectory?: string,
): Promise<{ close: (error?: unknown) => MaybePromise<void> } | undefined> {
  if (!isHarnessRelativeDirectory(directory)) {
    if (!resolved) return
    throw new Error("[vitehub] This Harness Agent Driver does not support skills({ scope: \"global\" }).")
  }
  const quotedDirectory = `'${directory.replace(/'/g, "'\\''")}'`
  const managedManifest = `${directory}.vitehub-managed`
  const quotedManagedManifest = `'${managedManifest.replace(/'/g, "'\\''")}'`
  const ensure = await (session as HarnessGlobalSkillsSandbox).run({
    abortSignal,
    ...(workingDirectory ? { workingDirectory } : {}),
    command: `mkdir -p -- ${quotedDirectory} && if [ -f ${quotedManagedManifest} ]; then while IFS= read -r encoded || [ -n "$encoded" ]; do managed=$(printf '%s' "$encoded" | base64 -d) || exit 1; case "$managed" in ''|/*|..|../*|*/..|*/../*) printf '%s\\n' 'Invalid ViteHub-managed Skill path.' >&2; exit 1 ;; esac; rm -rf -- ${quotedDirectory}/"$managed"; done < ${quotedManagedManifest}; fi && rm -f -- ${quotedManagedManifest}`,
  })
  if (ensure.exitCode !== 0) {
    throw new Error(`[vitehub] Failed to prepare global Skill directory: ${ensure.stderr || "sandbox command failed"}`)
  }
  if (!resolved) return
  const skillDirectories = resolved.paths.map(path => `'${`${directory}/${path}`.replace(/'/g, "'\\''")}'`).join(" ")
  const { prepareHarnessWorkspaceSession } = await import("@vite-hub/workspace")
  const stagingDirectory = `${directory}.vitehub-global-skills-${globalThis.crypto.randomUUID()}`
  const quotedStagingDirectory = `'${stagingDirectory.replace(/'/g, "'\\''")}'`
  const prepared = await prepareHarnessWorkspaceSession(resolved.workspace, {
    abortSignal,
    paths: resolved.paths,
    session: session as never,
    sessionWorkDir: workingDirectory ? posix.join(workingDirectory, stagingDirectory) : stagingDirectory,
  })
  const install = await (session as HarnessGlobalSkillsSandbox).run({
    abortSignal,
    ...(workingDirectory ? { workingDirectory } : {}),
    command: `cp -R ${quotedStagingDirectory}/. ${quotedDirectory} && rm -rf -- ${quotedStagingDirectory} && find ${skillDirectories} -type f -path "*/scripts/*" -exec chmod +x {} + && printf '%s\\n' ${resolved.paths.map(path => `'${Buffer.from(path).toString("base64")}'`).join(" ")} > ${quotedManagedManifest}`,
  })
  if (install.exitCode !== 0) {
    const error = new Error(`[vitehub] Failed to refresh global Skills: ${install.stderr || "sandbox command failed"}`)
    try {
      await (session as HarnessGlobalSkillsSandbox).run({
        abortSignal,
        ...(workingDirectory ? { workingDirectory } : {}),
        command: `rm -rf -- ${quotedStagingDirectory}`,
      })
    }
    catch {}
    await prepared.close(error)
    throw error
  }
  return prepared
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

function createSharedCleanupIterableWrapper(cleanup: (error?: unknown) => Promise<void>, abortSignal?: AbortSignal) {
  let activeIterators = 0
  return function wrap<T>(iterable: AsyncIterable<T>): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        const iterator = iterable[Symbol.asyncIterator]()
        activeIterators++
        let done = false
        const finish = async (error?: unknown) => {
          if (done) return
          done = true
          activeIterators--
          if (error || activeIterators === 0) {
            await cleanup(error)
          }
        }
        return {
          async next() {
            try {
              const result = await nextWithAbort(iterator.next(), abortSignal, "[vitehub] Harness Agent Driver stream aborted.")
              if (result.done) await finish()
              return result
            }
            catch (error) {
              void iterator.return?.().catch(() => {})
              await finish(error)
              throw error
            }
          },
          async return(value?: unknown) {
            try {
              return await iterator.return?.(value) ?? { done: true, value }
            }
            finally {
              await finish()
            }
          },
        }
      },
    }
  }
}

async function withSessionCleanup(
  result: unknown,
  cleanup: (error?: unknown) => Promise<void>,
  abortSignal: AbortSignal | undefined,
  waitUntil: AgentWaitUntil,
): Promise<unknown> {
  let cleanupTask: Promise<void> | undefined
  let markCleanupStarted!: () => void
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve
  })
  let onAbort: (() => void) | undefined
  const cleanupOnce = (error?: unknown) => {
    if (!cleanupTask) {
      cleanupTask = cleanup(error).finally(() => {
        if (onAbort) abortSignal?.removeEventListener("abort", onAbort)
      })
      markCleanupStarted()
    }
    return cleanupTask
  }
  const observeAbort = () => {
    if (!abortSignal) return
    onAbort = () => {
      waitUntil(cleanupOnce(abortSignal.reason))
    }
    if (abortSignal.aborted) onAbort()
    else abortSignal.addEventListener("abort", onAbort, { once: true })
  }

  if (isAsyncIterable(result)) {
    observeAbort()
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
  const wrapSharedCleanupIterable = createSharedCleanupIterableWrapper(cleanupOnce, abortSignal)
  for (const [key, iterable] of entries) {
    let wrapped = wrappedIterables.get(iterable)
    if (!wrapped) {
      wrapped = wrapSharedCleanupIterable(iterable)
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
  observeAbort()
  const responseMessages = (result as { responseMessages?: unknown }).responseMessages
  if (
    (typeof responseMessages === "object" && responseMessages !== null)
    || typeof responseMessages === "function"
  ) {
    const then = (responseMessages as { then?: unknown }).then
    if (typeof then === "function") {
      // Harness closes its eagerly produced streams before this terminal promise settles.
      const producerCleanup = Promise.resolve(responseMessages).then(
        () => cleanupOnce(),
        error => cleanupOnce(error),
      )
      waitUntil(Promise.race([
        producerCleanup,
        cleanupStarted.then(() => cleanupTask),
      ]))
    }
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

async function resolveHarnessProviderSessionId(
  sessionId: string,
  resumeKey: string,
  identity: HarnessSessionIdentity,
): Promise<string> {
  if (identity.box === undefined && identity.instructions === undefined && identity.workDir === undefined) return sessionId
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(resumeKey))
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
  return `vitehub-${fingerprint}`
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
    agentIdentity: Omit<HarnessSessionIdentity, "box">,
  ) {
    const identity: HarnessSessionIdentity = {
      ...agentIdentity,
      ...(context.box
        ? {
            box: {
              identity: context.box.plan.identity,
              runtime: context.box.plan.runtime,
              workspace: context.box.plan.workspace.path,
            },
          }
        : {}),
    }
    const sessionId = await resolveHarnessSessionKey(options.sessionKey, context)
    const resumeKey = sessionId ? JSON.stringify([sessionId, identity.instructions, identity.workDir, identity.box]) : undefined
    const providerSessionId = sessionId && resumeKey
      ? await resolveHarnessProviderSessionId(sessionId, resumeKey, identity)
      : undefined
    const resumesSession = resumeKey ? resumeStates.has(resumeKey) : false
    const resumeFrom = resumeKey ? resumeStates.get(resumeKey) : undefined
    const sessionOptions = {
      ...(context.input.abortSignal ? { abortSignal: context.input.abortSignal } : {}),
      ...(providerSessionId ? { sessionId: providerSessionId } : {}),
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
      finally {
        setActiveHarnessWorkspaceFiles(context.context, undefined)
      }
      if (!resumeKey || closeError) {
        if (resumeKey) resumeStates.delete(resumeKey)
        await destroySession(session)
        if (closeError !== error) throw closeError
        return
      }
      if (!hasDetach(session)) {
        resumeStates.delete(resumeKey)
        await destroySession(session)
        return
      }
      resumeStates.set(resumeKey, await session.detach())
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
    let workspaceSession: { close: (error?: unknown) => MaybePromise<void>, refreshGitBaseline?: () => MaybePromise<void> } | undefined
    let globalSkillsSession: { close: (error?: unknown) => MaybePromise<void> } | undefined
    let harnessProfileSession: { close: (error?: unknown) => MaybePromise<void> } | undefined
    let preparedSandbox: HarnessPreparedSandbox | undefined
    let attachmentDirectory: string | undefined
    const harnessInvocationId = globalThis.crypto.randomUUID()
    const skillsStagingDirectory = `.vitehub-agent-skills-${harnessInvocationId}`
    const colocatedWorkspaceSkills = await resolveHarnessColocatedSkills(context, `__vitehub_agent_workspace_skills_${harnessInvocationId}`)
    const colocatedGlobalSkills = await resolveHarnessColocatedSkills(context, `__vitehub_agent_global_skills_${harnessInvocationId}`)
    const invocation = {
      id: harnessInvocationId,
      isolateBoxHome: Boolean(context.box && colocatedGlobalSkills),
    }
    const resolved = await createHarnessAgent(options, context, invocation, async (session, sessionWorkDir, abortSignal, globalSkillsDirectory, globalSkillsWorkspace, sessionPrepare) => {
      preparedSandbox = {
        abortSignal,
        session: session as HarnessAttachmentSandbox,
        sessionWorkDir,
      }
      let globalSkillsWorkingDirectory: string | undefined
      if (context.box && isHarnessRelativeDirectory(globalSkillsDirectory)) {
        const home = await (session as HarnessGlobalSkillsSandbox).run({
          abortSignal,
          command: `printf '%s' "$HOME"`,
        })
        globalSkillsWorkingDirectory = home.stdout
        if (home.exitCode !== 0 || !globalSkillsWorkingDirectory || !posix.isAbsolute(globalSkillsWorkingDirectory)) {
          throw new Error(`[vitehub] Failed to resolve the Box Home directory: ${home.stderr || "sandbox command failed"}`)
        }
      }
      const harnessInstructions = context.workspace ? await resolveHarnessInstructions(context) : undefined
      try {
        if (context.workspace) {
          const { prepareHarnessWorkspaceSession } = await import("@vite-hub/workspace")
          const commitDefinition = context.workspaceDefinition && context.workspaceAutoCommit !== undefined
            ? workspaceDefinitionWithAutoCommitRules(context.workspaceDefinition, context.workspaceAutoCommit)
            : context.workspaceDefinition
          workspaceSession = await prepareHarnessWorkspaceSession(context.workspaceMaterializationSource || context.workspace, {
            abortSignal,
            ...(hasWorkspaceCommitRules(commitDefinition) ? { definition: commitDefinition } : {}),
            ignoreWriteBackPaths: harnessWriteBackIgnorePaths(context, harnessInstructions),
            onWriteBack: diff => setHarnessWorkspaceDiff(context.context, diff),
            paths: selectedWorkspaceScopePaths(context, commitDefinition),
            session: session as never,
            sessionWorkDir,
          })
          await writeHarnessInstructionFiles(session as HarnessInstructionSandbox, sessionWorkDir, abortSignal, harnessInstructions)
          if (harnessInstructions) await workspaceSession.refreshGitBaseline?.()
        }
        const globalSkillsDestination = globalSkillsWorkingDirectory && isHarnessRelativeDirectory(globalSkillsDirectory)
          ? posix.join(globalSkillsWorkingDirectory, globalSkillsDirectory)
          : undefined
        globalSkillsSession = await prepareHarnessGlobalSkills(
          globalSkillsWorkspace,
          session,
          globalSkillsDirectory,
          abortSignal,
          globalSkillsWorkingDirectory,
        )
        const installedWorkspaceSkills = await prepareHarnessColocatedSkills(colocatedWorkspaceSkills, session, sessionWorkDir, "skills", abortSignal, false, sessionWorkDir, skillsStagingDirectory)
        if (isHarnessRelativeDirectory(globalSkillsDirectory)) {
          const destination = globalSkillsDestination || globalSkillsDirectory
          await prepareHarnessColocatedSkills(
            colocatedGlobalSkills,
            session,
            destination,
            ".",
            abortSignal,
            true,
            destination,
            skillsStagingDirectory,
          )
        }
        if (installedWorkspaceSkills) await workspaceSession?.refreshGitBaseline?.()
        if (typeof sessionPrepare === "function") {
          const profile = await (sessionPrepare as (session: unknown, invocation: { id: string, isolateBoxHome: boolean }) => MaybePromise<unknown>)(session, invocation)
          if (profile && typeof profile === "object" && typeof (profile as { close?: unknown }).close === "function") {
            harnessProfileSession = profile as { close: (error?: unknown) => MaybePromise<void> }
          }
        }
      }
      catch (error) {
        try {
          try {
            await globalSkillsSession?.close(error)
          }
          finally {
            await workspaceSession?.close(error)
          }
        }
        finally {
          workspaceSession = undefined
          globalSkillsSession = undefined
          await harnessProfileSession?.close(error)
          harnessProfileSession = undefined
        }
        throw error
      }
    })
    const preparationSession = {
      async close(error?: unknown) {
        let closeError = error
        if (attachmentDirectory && preparedSandbox) {
          try {
            await removeHarnessAttachmentDirectory(preparedSandbox.session, attachmentDirectory)
          }
          catch (nextError) {
            closeError = nextError
          }
          attachmentDirectory = undefined
        }
        try {
          await globalSkillsSession?.close(closeError)
        }
        catch (nextError) {
          closeError = nextError
        }
        finally {
          try {
            await workspaceSession?.close(closeError)
          }
          catch (nextError) {
            closeError = nextError
          }
        }
        try {
          await harnessProfileSession?.close(closeError)
        }
        catch (nextError) {
          closeError = nextError
        }
        harnessProfileSession = undefined
        if (closeError !== error) throw closeError
      },
    }
    let created: Awaited<ReturnType<typeof createSession>>
    try {
      created = await createSession(resolved.agent, context, () => preparationSession, resolved)
    }
    catch (error) {
      await preparationSession.close(error)
      throw error
    }
    let chatPrompt: UserModelMessage | undefined
    try {
      if (context.context.has("chat") && context.messages.length) {
        const prepared = await prepareHarnessChatPrompt(context, created.resumesSession, preparedSandbox)
        attachmentDirectory = prepared.directory
        chatPrompt = prepared.prompt
      }
    }
    catch (error) {
      await created.cleanup(error)
      throw error
    }
    return {
      agent: resolved.agent,
      chatPrompt,
      ...created,
    }
  }

  return markMessageChannelInstructionConsumer({
    async generate(context) {
      const { agent, chatPrompt, cleanup, session, resumesSession } = await createAgentAndSession(context)
      try {
        const result = defineAgentUsageMetadata(await agent.generate({
          ...await toHarnessCallInput(context, resumesSession, chatPrompt),
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
      const { agent, chatPrompt, cleanup, session, resumesSession } = await createAgentAndSession(context)
      try {
        const result = defineAgentUsageMetadata(await agent.stream({
          ...await toHarnessCallInput(context, resumesSession, chatPrompt),
          session,
        }), usageMetadata)
        return await withSessionCleanup(result, cleanup, context.input.abortSignal, context.runtime.waitUntil)
      }
      catch (error) {
        await cleanup(error)
        throw error
      }
    },
  })
}
import { posix } from "node:path"
