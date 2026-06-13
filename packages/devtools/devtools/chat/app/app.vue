<script setup lang="ts">
import { Comark } from "@comark/vue"
import { connectRemoteDevTools, getDevToolsRpcClient, parseRemoteConnection } from "@vitejs/devtools-kit/client"
import type { UIMessage, UIMessagePart } from "ai"

import {
  chatDevtoolsClearRpc,
  chatDevtoolsGetStateRpc,
  chatDevtoolsMaterializeSourceRpc,
  chatDevtoolsSendRpc,
  chatDevtoolsStreamChannel,
  type ChatDevtoolsFileTreeItem,
  type ChatDevtoolsInvokerProfile,
  type ChatDevtoolsSendResult,
  type ChatDevtoolsStateResult,
  type ChatDevtoolsStreamEvent,
  type ChatDevtoolsTool,
  type ChatDevtoolsToolDefinition,
} from "../../../src/chat-shared.js"
import { resolveChatBridgeRoute } from "./bridge-route"
import { flattenFiles, sourceRootStates, syncExpandedFilePaths, type FileRow, type SourceRootState } from "./file-tree"

type ChatStatus = "ready" | "submitted" | "streaming" | "error"
type ChatMessage = UIMessage & { chat?: string }

const input = ref("")
const promptInput = ref<HTMLTextAreaElement>()
const status = ref<ChatStatus>("ready")
const error = ref<string | undefined>()
const connected = ref(false)
const isBusy = computed(() => status.value !== "ready")
const state = ref<ChatDevtoolsStateResult>({
  chats: [],
  files: [],
  instructions: [],
  invokerProfiles: [],
  selected: "",
  tools: [],
})
const messages = ref<ChatMessage[]>([])
const defaultChatTitle = "ViteHub Chat"
const loadingAssistantMessageId = "vitehub-devtools-loading-assistant"
const chatMessages = computed(() => {
  const next = [...messages.value]
  const latest = next.at(-1)
  if (status.value === "streaming" && thinkingFallback.value && (!latest || latest.role !== "assistant")) {
    next.push({
      id: loadingAssistantMessageId,
      role: "assistant",
      parts: [],
    })
  }
  return next as never
})
const pendingUserMessage = ref<ChatMessage | undefined>()
const expandedFilePaths = ref(new Set<string>())
const previousSourceRootStates = ref(new Map<string, SourceRootState>())
const selectedFilePath = ref<string | undefined>()
const sidebarWidth = ref(300)
let rpcClient: Awaited<ReturnType<typeof getDevToolsRpcClient>> | undefined
let currentReader: { cancel: () => unknown } | undefined
let metadataRefreshTimeout: ReturnType<typeof setTimeout> | undefined
let metadataRefreshEpoch = 0
let stopSidebarResize: (() => void) | undefined

const disconnectedStatusMessage = "Connect through Vite DevTools to inspect a real chat runtime."
const integrationTabs = [
  { icon: "i-lucide-files", label: "Files", slot: "files" as const },
  { icon: "i-lucide-wrench", label: "Tools", slot: "tools" as const },
  { icon: "i-lucide-scroll-text", label: "Instructions", slot: "instructions" as const },
]

type FileMaterialization = {
  materialize?: string
  materialized?: boolean
  materializedAt?: string
  source?: string
  status?: "lazy" | "updating" | "ready" | "error"
}

const fileRows = computed<FileRow[]>(() => flattenFiles(state.value.files || [], expandedFilePaths.value))
const splitterStyle = computed(() => ({
  "--chat-devtools-sidebar-width": `${sidebarWidth.value}px`,
}))
const thinkingFallback = computed(() => state.value.thinkingFallback || undefined)
const chatTitleTarget = computed(() => normalizeChatTitle(selectedChat()?.title || state.value.title))
const agentVersion = computed(() => state.value.version?.trim())
const fallbackInvokerProfileId = "__vitehub_fallback__"
const selectedInvokerProfileId = ref<string | undefined>()
const invokerProfiles = computed<ChatDevtoolsInvokerProfile[]>(() => state.value.invokerProfiles || [])
const showInvokerSelector = computed(() => invokerProfiles.value.length > 0)
const selectedConversationMessages = computed(() => stateUiMessages(state.value, state.value.selected))
const isInvokerLocked = computed(() => selectedConversationMessages.value.length > 0 || messages.value.length > 0 || isBusy.value)
const invokerSelectorTooltip = computed(() => isInvokerLocked.value ? "Clear the conversation to change invoker." : "")
const invokerSelectItems = computed(() => [
  ...invokerProfiles.value.map(profile => ({
    label: profile.label || profile.kind || profile.id,
    value: profile.id,
  })),
  { label: "Fallback", value: fallbackInvokerProfileId },
])
const recentTools = computed(() => {
  const tools = new Map<string, ChatDevtoolsTool>()
  for (const message of messages.value) {
    for (const part of chatToolParts(message.parts)) {
      tools.set(part.tool.name, part.tool)
    }
  }
  return tools
})

const visibleTools = computed<ChatDevtoolsToolDefinition[]>(() => {
  if (state.value.tools?.length) {
    return state.value.tools
  }
  return [...recentTools.value.values()].map(tool => ({
    name: tool.name,
    description: tool.text,
    status: tool.status === "error" ? "disabled" : "available",
  }))
})
const metadataStatus = computed(() => state.value.metadataStatus || "ready")
const isMetadataLoading = computed(() => metadataStatus.value === "loading")
const metadataError = computed(() => state.value.metadataError)

function clearPendingMessages() {
  const pendingId = pendingUserMessage.value?.id
  pendingUserMessage.value = undefined
  messages.value = messages.value.filter(message => message.id !== pendingId)
}

function selectedChat(next = state.value) {
  return next.chats.find(chat => chat.name === next.selected) || next.chats[0]
}

function normalizeChatTitle(value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim() || defaultChatTitle
}

function applyState(next: ChatDevtoolsStateResult) {
  state.value = {
    files: next.files || [],
    instructions: next.instructions || [],
    invokerProfiles: next.invokerProfiles || [],
    tools: next.tools || [],
    ...next,
  }
  syncInvokerSelection(next)
  const chat = selectedChat(next)
  const serverMessages = chat?.uiMessages || next.uiMessages || []
  const nextMessages = [...serverMessages]
  const pending = pendingUserMessage.value

  if (pending && pending.chat === chat?.name && serverMessages.some(message => message.role === "user" && uiMessageContent(message) === uiMessageContent(pending))) {
    pendingUserMessage.value = undefined
  }
  else if (pending && pending.chat === chat?.name && !serverMessages.some(message => message.id === pending.id)) {
    nextMessages.push(pending)
  }
  else {
    pendingUserMessage.value = undefined
  }

  messages.value = nextMessages
  syncExpandedFiles(state.value.files || [])
  if (isMetadataLoading.value) {
    scheduleMetadataRefresh()
  }
  else {
    stopMetadataRefresh()
  }
}

function syncInvokerSelection(next: ChatDevtoolsStateResult) {
  const profiles = next.invokerProfiles || []
  if (!profiles.length) {
    selectedInvokerProfileId.value = undefined
    return
  }
  const selected = selectedChat(next)
  if (selected?.invokerFallback || next.invokerFallback) {
    selectedInvokerProfileId.value = fallbackInvokerProfileId
    return
  }
  const profileId = selected?.invokerProfileId || next.invokerProfileId
  if (profileId && profiles.some(profile => profile.id === profileId)) {
    selectedInvokerProfileId.value = profileId
    return
  }
  if (selectedInvokerProfileId.value === fallbackInvokerProfileId) {
    return
  }
  if (selectedInvokerProfileId.value && profiles.some(profile => profile.id === selectedInvokerProfileId.value)) {
    return
  }
  selectedInvokerProfileId.value = profiles[0]?.id
}

function selectedInvokerRequest() {
  if (selectedInvokerProfileId.value === fallbackInvokerProfileId) {
    return { invokerFallback: true }
  }
  return selectedInvokerProfileId.value
    ? { invokerProfileId: selectedInvokerProfileId.value }
    : {}
}

function applyStreamEvent(event: ChatDevtoolsStreamEvent) {
  if (event.type === "state") {
    applyState(event.state)
    return
  }
  if (event.type === "error") {
    clearPendingMessages()
    error.value = event.message
  }
}

function uiMessageContent(message: UIMessage) {
  return message.parts
    .filter((part): part is { text: string, type: "text" } => part.type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map(part => part.text)
    .join("")
}

function stateUiMessages(next: ChatDevtoolsStateResult, chatName: string | undefined) {
  const chat = (chatName ? next.chats.find(item => item.name === chatName) : undefined) || next.chats[0]
  return chat?.uiMessages || next.uiMessages || []
}

function hasCompletedResponse(next: ChatDevtoolsStateResult, chatName: string | undefined, text: string) {
  const messages = stateUiMessages(next, chatName)
  const userIndex = messages.findLastIndex(message => message.role === "user" && uiMessageContent(message) === text)
  if (userIndex < 0) return false

  return messages.slice(userIndex + 1).some(message =>
    message.role === "assistant"
    && !hasRunningTool(message.parts)
    && !!uiMessageContent(message).trim(),
  )
}

function hasCurrentUserMessage(next: ChatDevtoolsStateResult, chatName: string | undefined, text: string) {
  return stateUiMessages(next, chatName).some(message => message.role === "user" && uiMessageContent(message) === text)
}

function renderedMessageContent(content: unknown, message: { content?: unknown }) {
  const partsText = uiMessageContent(message as UIMessage)
  return partsText
    || (typeof content === "string" && content.trim()
      ? content
      : typeof message.content === "string" && message.content.trim()
      ? message.content
      : undefined)
}

function renderedMessageKey(content: unknown, message: { content?: unknown, id?: unknown }) {
  const rendered = renderedMessageContent(content, message)
  return `${typeof message.id === "string" ? message.id : "message"}:${rendered?.length ?? 0}:${rendered ?? ""}`
}

function commandFromTool(tool: ChatDevtoolsTool) {
  const input = tool.input && typeof tool.input === "object" ? tool.input as Record<string, unknown> : {}
  return typeof input.command === "string" ? input.command.trim() : undefined
}

function renderToolCommand(tool: ChatDevtoolsTool) {
  const input = tool.input && typeof tool.input === "object" ? tool.input as Record<string, unknown> : {}
  const command = commandFromTool(tool)
  if (tool.name === "materialize_sources") {
    return `Updating source metadata for ${typeof input.path === "string" && input.path ? input.path : "workspace"}`
  }
  if (command) {
    return command
  }
  if (typeof input.path === "string") {
    return `${tool.name} ${input.path}`
  }
  if (typeof input.query === "string") {
    return `${tool.name} "${input.query}"`
  }
  return tool.text || tool.name
}

function toolIcon(tool: ChatDevtoolsTool) {
  return tool.name === "materialize_sources" ? "i-lucide-database-zap" : "i-lucide-terminal"
}

function toolMetadataLabel(tool: ChatDevtoolsTool) {
  return tool.name === "materialize_sources" ? "Metadata" : undefined
}

function renderToolOutput(tool: ChatDevtoolsTool) {
  const output = tool.output
  if (output == null) {
    return ""
  }
  if (typeof output === "string") {
    return output
  }
  if (Array.isArray(output)) {
    return output.map(item => `- ${String(item)}`).join("\n")
  }
  if (typeof output === "object") {
    const record = output as Record<string, unknown>
    if (typeof record.stdout === "string" || typeof record.stderr === "string") {
      return typeof record.stdout === "string" && record.stdout
        ? record.stdout.trimEnd()
        : String(record.stderr || "").trimEnd()
    }
    if (Array.isArray(record.matches)) {
      return [
        "### Matches",
        ...record.matches.map(item => `- ${String(item)}`),
      ].join("\n")
    }
    if (typeof record.summary === "string") {
      return [
        record.summary,
        typeof record.bytes === "number" ? `\n_${record.bytes.toLocaleString()} bytes read._` : "",
      ].filter(Boolean).join("\n")
    }
  }
  return `\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``
}

function syncExpandedFiles(files: ChatDevtoolsFileTreeItem[]) {
  expandedFilePaths.value = syncExpandedFilePaths(files, expandedFilePaths.value, previousSourceRootStates.value)
  previousSourceRootStates.value = sourceRootStates(files)
}

function fileLabel(file: ChatDevtoolsFileTreeItem) {
  return file.label || file.path.split("/").filter(Boolean).at(-1) || file.path || "workspace"
}

function toggleFile(file: ChatDevtoolsFileTreeItem) {
  if (isLazyFile(file)) {
    void materializeFile(file)
    return
  }
  if (file.kind === "file") {
    selectedFilePath.value = file.path
    return
  }
  const expanded = new Set(expandedFilePaths.value)
  if (expanded.has(file.path)) {
    expanded.delete(file.path)
  }
  else {
    expanded.add(file.path)
  }
  expandedFilePaths.value = expanded
}

function fileMaterialization(file: ChatDevtoolsFileTreeItem): "lazy" | "materialized" | "updating" | undefined {
  const meta = file as ChatDevtoolsFileTreeItem & FileMaterialization
  if (meta.status === "updating") return "updating"
  if (meta.status === "ready" || meta.materialized || meta.materializedAt) return "materialized"
  if (meta.status === "lazy" || (meta.materialized === false && meta.materialize === "lazy")) return "lazy"
  return undefined
}

function isLazyFile(file: ChatDevtoolsFileTreeItem) {
  return fileMaterialization(file) === "lazy" && Boolean((file as ChatDevtoolsFileTreeItem & FileMaterialization).source)
}

function fileMaterializationBadge(file: ChatDevtoolsFileTreeItem) {
  const materialization = fileMaterialization(file)
  if (materialization === "updating") return "Updating"
  if (materialization === "lazy") return "Lazy"
}

function fileMaterializationColor(file: ChatDevtoolsFileTreeItem) {
  return fileMaterialization(file) === "updating" ? "primary" : "warning"
}

function mapFileTree(
  files: ChatDevtoolsFileTreeItem[],
  path: string,
  update: (file: ChatDevtoolsFileTreeItem) => ChatDevtoolsFileTreeItem,
): ChatDevtoolsFileTreeItem[] {
  return files.map((file) => {
    const children = file.children ? mapFileTree(file.children, path, update) : undefined
    const next = children ? { ...file, children } : file
    return file.path === path ? update(next) : next
  })
}

function setFileStatus(path: string, status: FileMaterialization["status"]) {
  state.value = {
    ...state.value,
    files: mapFileTree(state.value.files || [], path, file => ({ ...file, status })),
  }
}

async function materializeFile(file: ChatDevtoolsFileTreeItem) {
  const source = (file as ChatDevtoolsFileTreeItem & FileMaterialization).source
  if (!source) {
    toggleFile(file)
    return
  }

  metadataRefreshEpoch += 1
  stopMetadataRefresh()
  setFileStatus(file.path, "updating")
  try {
    const bridgeState = await callBridgeState({
      action: chatDevtoolsMaterializeSourceRpc,
      chat: state.value.selected,
      path: file.path,
      source,
      ...selectedInvokerRequest(),
    })
    if (bridgeState) {
      applyState(bridgeState)
      expandedFilePaths.value = new Set([...expandedFilePaths.value, file.path])
      error.value = undefined
      return
    }
    await refreshFromBridge(state.value.selected)
  }
  catch (cause) {
    setFileStatus(file.path, "error")
    error.value = cause instanceof Error ? cause.message : "Workspace source materialization failed."
  }
}

function hasToolOutput(tool: ChatDevtoolsTool) {
  if (tool.output === undefined || tool.output === null) return false
  if (typeof tool.output === "string") return tool.output.trim().length > 0
  return true
}

function startSidebarResize(event: PointerEvent) {
  if (event.pointerType === "mouse" && event.button !== 0) return
  event.preventDefault()
  const onMove = (moveEvent: PointerEvent) => {
    sidebarWidth.value = Math.min(480, Math.max(260, window.innerWidth - moveEvent.clientX))
  }
  const onUp = () => {
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onUp)
    stopSidebarResize = undefined
  }
  stopSidebarResize?.()
  document.body.style.cursor = "col-resize"
  document.body.style.userSelect = "none"
  window.addEventListener("pointermove", onMove)
  window.addEventListener("pointerup", onUp, { once: true })
  stopSidebarResize = onUp
}

function toolStatus(tool: ChatDevtoolsToolDefinition) {
  return recentTools.value.get(tool.name)?.status || tool.status || "available"
}

function toolStatusColor(tool: ChatDevtoolsToolDefinition) {
  const status = toolStatus(tool)
  if (status === "disabled" || status === "error") return "error"
  if (status === "running") return "warning"
  return "success"
}

function toolPresetLabel(tool: ChatDevtoolsToolDefinition) {
  return tool.preset === "vitehub-workspace" ? "ViteHub preset" : undefined
}

function instructionLabel(instruction: unknown) {
  return typeof instruction === "object" && instruction !== null && "label" in instruction && typeof (instruction as { label?: unknown }).label === "string"
    ? (instruction as { label: string }).label
    : "System instructions"
}

function instructionContent(instruction: unknown) {
  return typeof instruction === "string"
    ? instruction
    : typeof instruction === "object" && instruction !== null && "content" in instruction && typeof (instruction as { content?: unknown }).content === "string"
      ? (instruction as { content: string }).content
      : ""
}

function isLoadingMessage(message: unknown) {
  const typed = message as UIMessage | undefined
  return status.value === "streaming"
    && typed?.role === "assistant"
    && Boolean(thinkingFallback.value)
    && (typed.id === loadingAssistantMessageId || messages.value.at(-1)?.id === typed.id)
    && !uiMessageContent(typed).trim()
}

function loadingMessageText() {
  return thinkingFallback.value || ""
}

function chatToolParts(parts: unknown): Array<{ type: "tool", tool: ChatDevtoolsTool }> {
  return Array.isArray(parts)
    ? parts.flatMap((part) => {
        if (typeof part !== "object" || part === null) return []
        const typed = part as UIMessagePart<any, any> & { tool?: ChatDevtoolsTool, toolCallId?: string, toolName?: string, input?: unknown, output?: unknown, errorText?: string, state?: string, title?: string }
        if (typed.type === "tool" && typed.tool) return [{ type: "tool" as const, tool: typed.tool }]
        if (typed.type === "dynamic-tool" || typed.type.startsWith("tool-")) {
          const name = typed.type === "dynamic-tool" ? typed.toolName || "tool" : typed.type.slice("tool-".length)
          const tool: ChatDevtoolsTool = {
            id: typed.toolCallId || `${name}-${JSON.stringify(typed.input ?? {}).length}`,
            input: typed.input,
            name,
            output: typed.output ?? typed.errorText,
            status: typed.state === "output-error"
              ? "error"
              : typed.state === "output-available" || typed.state === "output-denied"
                ? "completed"
                : "running",
            text: typed.title || name,
            updatedAt: new Date().toISOString(),
          }
          return [{ type: "tool" as const, tool }]
        }
        return []
      })
    : []
}

function hasToolParts(parts: unknown) {
  return chatToolParts(parts).length > 0
}

function hasRunningTool(parts: unknown) {
  return chatToolParts(parts).some(part => part.tool.status === "running")
}

function formatThoughtDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}

function thoughtDuration(message: unknown, parts: unknown) {
  const metadata = (message as UIMessage | undefined)?.metadata as { completedAt?: string, createdAt?: string, updatedAt?: string } | undefined
  const createdAt = Date.parse(metadata?.createdAt || "")
  if (!Number.isFinite(createdAt)) return undefined

  const toolTimes = chatToolParts(parts)
    .map(part => Date.parse(part.tool.updatedAt))
    .filter(Number.isFinite)
  const metadataEndedAt = Date.parse(metadata?.completedAt || metadata?.updatedAt || "")
  const endedAt = Number.isFinite(metadataEndedAt)
    ? metadataEndedAt
    : toolTimes.length ? Math.max(...toolTimes) : Date.now()
  return formatThoughtDuration(endedAt - createdAt)
}

function toolsSummary(message: unknown, parts: unknown) {
  const count = chatToolParts(parts).length
  const tools = count === 1 ? "1 tool" : `${count} tools`
  const duration = thoughtDuration(message, parts)
  return duration ? `${tools} · thought for ${duration}` : tools
}

function reasoningLabel(message: unknown, parts: unknown) {
  if (isLoadingMessage(message) || hasRunningTool(parts)) {
    return loadingMessageText()
  }
  return toolsSummary(message, parts)
}

function appendPendingUserMessage(text: string, chat: string | undefined) {
  pendingUserMessage.value = {
    chat,
    id: `pending-user-${Date.now()}`,
    role: "user",
    parts: [{ type: "text", text }],
  }
  messages.value = [...messages.value, pendingUserMessage.value]
}

function waitForFrame() {
  return new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}

function stopMetadataRefresh() {
  if (!metadataRefreshTimeout) return
  clearTimeout(metadataRefreshTimeout)
  metadataRefreshTimeout = undefined
}

function scheduleMetadataRefresh() {
  if (metadataRefreshTimeout || metadataStatus.value !== "loading") return
  metadataRefreshTimeout = setTimeout(async () => {
    metadataRefreshTimeout = undefined
    if (metadataStatus.value === "loading") {
      await refreshFromBridge(state.value.selected)
    }
  }, 700)
}

function localBridgeRoute() {
  const remoteConnection = parseRemoteConnection()
  return resolveChatBridgeRoute({
    ancestorOrigin: globalThis.location?.ancestorOrigins?.[0],
    pathname: globalThis.location?.pathname,
    referrer: globalThis.document?.referrer,
    remoteOrigin: remoteConnection?.origin,
  })
}

function shouldPreferRpcBridge() {
  return Boolean(parseRemoteConnection()?.origin)
}

async function callRpc<T>(method: string, ...args: unknown[]): Promise<T> {
  if (!rpcClient) {
    if (parseRemoteConnection()) {
      rpcClient = await connectRemoteDevTools()
    }
    else {
      rpcClient = await getDevToolsRpcClient()
    }
  }
  connected.value = true
  return await (rpcClient as { call: (method: string, ...args: unknown[]) => Promise<unknown> }).call(method, ...args) as T
}

async function callBridgeState(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatDevtoolsStateResult | undefined> {
  try {
    const response = await fetch(localBridgeRoute(), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) return undefined

    connected.value = true
    return await response.json() as ChatDevtoolsStateResult
  }
  catch {
    return undefined
  }
}

function canApplyMetadataRefresh(epoch: number | undefined) {
  return epoch === undefined || epoch === metadataRefreshEpoch
}

async function refresh(options: { metadataRefreshEpoch?: number } = {}) {
  if (!shouldPreferRpcBridge()) {
    const bridgeState = await callBridgeState({ action: "get-state", ...selectedInvokerRequest() })
    if (bridgeState) {
      if (!canApplyMetadataRefresh(options.metadataRefreshEpoch)) return
      applyState(bridgeState)
      error.value = undefined
      return
    }
  }

  try {
    const next = await callRpc<ChatDevtoolsStateResult>(
      chatDevtoolsGetStateRpc,
      selectedInvokerRequest(),
    )
    if (!canApplyMetadataRefresh(options.metadataRefreshEpoch)) return
    applyState(next)
    error.value = undefined
  }
  catch (cause) {
    connected.value = false
    error.value = cause instanceof Error ? cause.message : "Open this page from Vite DevTools to connect to your local chat."
  }
}

async function refreshFromBridge(chat?: string) {
  const refreshEpoch = metadataRefreshEpoch
  if (shouldPreferRpcBridge()) {
    await refresh({ metadataRefreshEpoch: refreshEpoch })
    return
  }

  const bridgeState = await callBridgeState({
    action: "get-state",
    ...(chat ? { chat } : {}),
    ...selectedInvokerRequest(),
  })
  if (bridgeState) {
    if (!canApplyMetadataRefresh(refreshEpoch)) return
    applyState(bridgeState)
    error.value = undefined
    return
  }
  await refresh({ metadataRefreshEpoch: refreshEpoch })
}

async function pollFinalBridgeState(input: { chat?: string, invokerFallback?: boolean, invokerProfileId?: string, text: string }, signal: AbortSignal) {
  while (!signal.aborted) {
    await new Promise(resolve => setTimeout(resolve, 700))
    if (signal.aborted) break

    const next = await callBridgeState({
      action: "get-state",
      ...(input.chat ? { chat: input.chat } : {}),
      ...(input.invokerFallback ? { invokerFallback: input.invokerFallback } : {}),
      ...(input.invokerProfileId ? { invokerProfileId: input.invokerProfileId } : {}),
    }, signal)
    if (!next) continue

    if (hasCurrentUserMessage(next, input.chat, input.text)) {
      if (!signal.aborted) {
        applyState(next)
        error.value = undefined
      }
    }
    if (hasCompletedResponse(next, input.chat, input.text)) {
      return true
    }
  }

  return false
}

async function recoverTimedOutBridgeSend(input: { chat?: string, invokerFallback?: boolean, invokerProfileId?: string, text: string }, signal: AbortSignal) {
  const startedAt = Date.now()
  let sawSubmittedMessage = false

  while (!signal.aborted && Date.now() - startedAt < 60_000) {
    await new Promise(resolve => setTimeout(resolve, 700))
    if (signal.aborted) break

    const next = await callBridgeState({
      action: "get-state",
      ...(input.chat ? { chat: input.chat } : {}),
      ...(input.invokerFallback ? { invokerFallback: input.invokerFallback } : {}),
      ...(input.invokerProfileId ? { invokerProfileId: input.invokerProfileId } : {}),
    }, signal)
    if (!next) continue

    if (hasCurrentUserMessage(next, input.chat, input.text)) {
      sawSubmittedMessage = true
      applyState(next)
      error.value = undefined
    }
    if (hasCompletedResponse(next, input.chat, input.text)) {
      return true
    }
    if (!sawSubmittedMessage && Date.now() - startedAt > 3_000) {
      return false
    }
  }

  return false
}

async function pollFinalRpcState(input: { chat?: string, invokerFallback?: boolean, invokerProfileId?: string, text: string }, signal: AbortSignal) {
  while (!signal.aborted) {
    await new Promise(resolve => setTimeout(resolve, 700))
    if (signal.aborted) break

    try {
      const next = await callRpc<ChatDevtoolsStateResult>(chatDevtoolsGetStateRpc, {
        ...(input.chat ? { chat: input.chat } : {}),
        ...(input.invokerFallback ? { invokerFallback: input.invokerFallback } : {}),
        ...(input.invokerProfileId ? { invokerProfileId: input.invokerProfileId } : {}),
      })
      if (hasCurrentUserMessage(next, input.chat, input.text)) {
        applyState(next)
        error.value = undefined
      }
      if (hasCompletedResponse(next, input.chat, input.text)) {
        return true
      }
    }
    catch {
      if (signal.aborted) break
    }
  }

  return false
}

async function readDirectBridgeStream(input: { chat?: string, invokerFallback?: boolean, invokerProfileId?: string, text: string }): Promise<boolean> {
  const abortController = new AbortController()
  currentReader = { cancel: () => abortController.abort() }

  let response: Response | undefined
  const connectTimeoutController = new AbortController()
  let connectTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    connectTimeout = setTimeout(() => connectTimeoutController.abort(), 15_000)
    response = await fetch(localBridgeRoute(), {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ action: "send", ...input, stream: true }),
        signal: AbortSignal.any([abortController.signal, connectTimeoutController.signal]),
      })
  }
  catch {
    if (abortController.signal.aborted) {
      currentReader = undefined
      return true
    }
    if (connectTimeoutController.signal.aborted) {
      try {
        if (await recoverTimedOutBridgeSend(input, abortController.signal)) {
          return true
        }
        error.value = "Chat DevTools bridge timed out before confirming the message."
        return true
      }
      finally {
        abortController.abort()
        currentReader = undefined
      }
    }

    currentReader = undefined
    return false
  }
  finally {
    if (connectTimeout) clearTimeout(connectTimeout)
  }

  if (!response.ok || !response.body) {
    currentReader = undefined
    return false
  }

  connected.value = true
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""

  const readStream = async (): Promise<"done" | "error" | false> => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() || ""
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line) as ChatDevtoolsStreamEvent
          applyStreamEvent(event)
          if (event.type === "error") return "error"
          if (event.type === "done") return "done"
        }
      }

      const tail = pending.trim()
      if (tail) {
        const event = JSON.parse(tail) as ChatDevtoolsStreamEvent
        applyStreamEvent(event)
        if (event.type === "error") return "error"
        if (event.type === "done") return "done"
      }
      return "done"
    }
    catch {
      return abortController.signal.aborted ? "done" : "interrupted"
    }
  }

  try {
    const outcome = await Promise.race([
      readStream(),
      pollFinalBridgeState(input, abortController.signal),
    ])
    if (outcome === "error") {
      return true
    }
    if (outcome === "done") {
      return true
    }
    if (outcome === "interrupted") {
      if (await recoverTimedOutBridgeSend(input, abortController.signal)) {
        return true
      }
      error.value = "Chat DevTools bridge stream disconnected before confirming the message."
      return true
    }
    if (!outcome || hasCompletedResponse(state.value, input.chat, input.text)) {
      return Boolean(outcome)
    }

    return await pollFinalBridgeState(input, abortController.signal)
  }
  finally {
    abortController.abort()
    currentReader = undefined
  }
}

async function readRpcStream(streamId: string, input: { chat?: string, invokerFallback?: boolean, invokerProfileId?: string, text: string }) {
  const abortController = new AbortController()
  const reader = (rpcClient as { streaming?: { subscribe: <T>(channel: string, id: string, options?: Record<string, unknown>) => AsyncIterable<T> & { cancel: () => unknown } } } | undefined)?.streaming?.subscribe<ChatDevtoolsStreamEvent>(chatDevtoolsStreamChannel, streamId, {
    highWaterMark: 1024,
  })
  if (!reader) {
    const timeout = setTimeout(() => abortController.abort(), 60_000)
    try {
      const completed = await pollFinalRpcState(input, abortController.signal)
      if (!completed) {
        throw new Error("Chat DevTools RPC polling timed out.")
      }
      return completed
    }
    finally {
      clearTimeout(timeout)
      abortController.abort()
    }
  }

  currentReader = {
    cancel: () => {
      abortController.abort()
      return reader.cancel()
    },
  }

  const readStream = async () => {
    for await (const event of reader) {
      applyStreamEvent(event)
      if (event.type === "error") return "error"
      if (event.type === "done") return "done"
    }
    return "done"
  }

  try {
    const outcome = await readStream()
    return outcome !== "error"
  }
  finally {
    abortController.abort()
    currentReader = undefined
  }
}

async function send() {
  const text = (input.value || promptInput.value?.value || "").trim()
  if (!text || status.value !== "ready") {
    return
  }

  input.value = ""
  status.value = "submitted"
  error.value = undefined
  let chat: string | undefined
  let shouldRefreshFinalState = false

  try {
    chat = selectedChat()?.name
    currentReader?.cancel()
    currentReader = undefined
    appendPendingUserMessage(text, chat)
    await nextTick()
    await waitForFrame()
    status.value = "streaming"

    const bridgeInput = {
      ...(chat ? { chat } : {}),
      ...selectedInvokerRequest(),
      text,
    }
    if (!shouldPreferRpcBridge()) {
      if (await readDirectBridgeStream(bridgeInput)) {
        if (error.value) {
          return
        }
        status.value = "ready"
        await refreshFromBridge(chat)
        return
      }
    }

    const result = await callRpc<ChatDevtoolsSendResult>(chatDevtoolsSendRpc, {
      ...(chat ? { chat } : {}),
      ...selectedInvokerRequest(),
      stream: true,
      text,
    })
    if (!result.streamId) {
      applyState(result)
      status.value = "ready"
      return
    }

    if (await readRpcStream(result.streamId, bridgeInput)) {
      shouldRefreshFinalState = true
    }
  }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : "Chat DevTools send failed."
    clearPendingMessages()
    error.value = message
    connected.value = false
  }
  finally {
    currentReader = undefined
    if (shouldRefreshFinalState) {
      status.value = "ready"
      await refreshFromBridge(chat)
    }
    status.value = "ready"
  }
}

function stop() {
  currentReader?.cancel()
  currentReader = undefined
  status.value = "ready"
}

function submitComposer() {
  if (isBusy.value) {
    stop()
    return
  }
  void send()
}

async function clear() {
  try {
    currentReader?.cancel()
    currentReader = undefined
    pendingUserMessage.value = undefined
    const invokerRequest = selectedInvokerRequest()
    const bridgeState = await callBridgeState({ action: "clear", chat: state.value.selected, ...invokerRequest })
    applyState(bridgeState || await callRpc<ChatDevtoolsStateResult>(chatDevtoolsClearRpc, {
        chat: state.value.selected,
        ...invokerRequest,
      }))
    error.value = undefined
  }
  catch {
    state.value = {
      chats: [{ name: state.value.selected || "dev", messages: [] }],
      files: state.value.files || [],
      instructions: state.value.instructions || [],
      invokerProfiles: state.value.invokerProfiles || [],
      selected: state.value.selected || "dev",
      tools: state.value.tools || [],
    }
    pendingUserMessage.value = undefined
    messages.value = []
    error.value = undefined
    status.value = "ready"
  }
}

onMounted(() => {
  syncExpandedFiles(state.value.files || [])
  refresh()
})
watch(selectedInvokerProfileId, async (next, previous) => {
  if (!next || next === previous || isInvokerLocked.value) return
  metadataRefreshEpoch += 1
  stopMetadataRefresh()
  state.value = {
    ...state.value,
    files: [],
    instructions: [],
    metadataError: undefined,
    metadataStatus: "loading",
    tools: [],
  }
  await refreshFromBridge(state.value.selected)
})
onBeforeUnmount(() => {
  stopMetadataRefresh()
  stopSidebarResize?.()
})
</script>

<template>
  <UApp>
    <main class="fixed inset-0 isolate flex min-h-0 flex-col overflow-hidden bg-default text-default antialiased">
      <UIcon name="i-lucide-terminal" class="hidden" />
      <header class="flex min-h-10 shrink-0 flex-col justify-center gap-2 border-b border-default px-3 py-2 sm:h-10 sm:flex-row sm:items-center sm:justify-between sm:py-0">
        <h1
          class="flex min-w-0 items-center text-sm font-semibold sm:flex-1"
          :aria-label="chatTitleTarget"
          :title="chatTitleTarget"
        >
          <span class="min-w-0 truncate">
            {{ chatTitleTarget }}
          </span>
          <UBadge
            v-if="agentVersion"
            color="neutral"
            variant="subtle"
            size="xs"
            class="ml-2 shrink-0"
          >
            v{{ agentVersion }}
          </UBadge>
        </h1>
        <div class="flex w-full min-w-0 items-center gap-1.5 sm:w-auto sm:shrink-0">
          <UTooltip
            v-if="showInvokerSelector"
            :text="invokerSelectorTooltip"
            :disabled="!isInvokerLocked"
          >
            <USelect
              v-model="selectedInvokerProfileId"
              :items="invokerSelectItems"
              value-key="value"
              label-key="label"
              :disabled="isInvokerLocked"
              size="xs"
              class="min-w-0 flex-1 sm:w-48 sm:flex-none"
              :ui="{ base: 'min-w-0' }"
            />
          </UTooltip>
          <UButton
            icon="i-lucide-trash-2"
            label="Clear"
            color="neutral"
            variant="outline"
            size="xs"
            class="shrink-0"
            @click="clear"
          />
        </div>
      </header>

      <div class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(150px,32svh)] overflow-hidden md:grid-cols-[minmax(0,1fr)_1px_minmax(260px,var(--chat-devtools-sidebar-width))] md:grid-rows-1" :style="splitterStyle">
        <section class="flex min-h-0 flex-col overflow-hidden">
          <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2">
            <UChatMessages
              v-if="chatMessages.length"
              :messages="chatMessages"
              :should-auto-scroll="status === 'streaming'"
              compact
              class="min-h-full px-3 py-2"
            >
              <template #content="{ content, message, parts }">
                <div class="flex w-full min-w-0 flex-col gap-2 text-sm/5">
                  <UCollapsible
                    v-if="isLoadingMessage(message) || hasToolParts(parts)"
                    :default-open="isLoadingMessage(message) || hasRunningTool(parts)"
                    :unmount-on-hide="false"
                    :ui="{
                      root: 'w-full min-w-0',
                      content: 'w-full overflow-visible',
                    }"
                  >
                    <button
                      type="button"
                      class="group flex w-full min-w-0 items-center gap-1.5 rounded-md text-xs text-muted transition-colors hover:text-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-muted"
                    >
                      <UIcon
                        name="i-lucide-chevron-right"
                        class="size-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-90"
                      />
                      <UChatShimmer
                        v-if="isLoadingMessage(message) || hasRunningTool(parts)"
                        :text="reasoningLabel(message, parts)"
                        :duration="1.8"
                        class="min-w-0 truncate"
                      />
                      <span v-else class="min-w-0 truncate">
                        {{ reasoningLabel(message, parts) }}
                      </span>
                    </button>

                    <template #content>
                      <div class="flex w-full min-w-0 flex-col gap-2 px-px pb-px pt-2 text-xs/5">
                        <UChatTool
                          v-for="part in chatToolParts(parts)"
                          :key="part.tool.id"
                          :icon="toolIcon(part.tool)"
                          :text="renderToolCommand(part.tool)"
                          :streaming="part.tool.status === 'running'"
                          variant="card"
                          :default-open="false"
                          :ui="{
                            root: 'w-full min-w-0 self-stretch rounded-md',
                            trigger: 'min-h-7 w-full px-2 py-1 text-xs focus-visible:ring-1 focus-visible:ring-muted focus-visible:outline-none',
                            leading: 'size-3.5',
                            leadingIcon: 'size-3.5 opacity-70',
                            label: 'min-w-0 truncate',
                            trailingIcon: 'size-3.5 opacity-70',
                            body: 'p-2 text-xs/5',
                          }"
                        >
                          <template v-if="toolMetadataLabel(part.tool)" #actions>
                            <UBadge color="neutral" variant="soft" size="sm">
                              {{ toolMetadataLabel(part.tool) }}
                            </UBadge>
                          </template>
                          <pre
                            v-if="hasToolOutput(part.tool)"
                            class="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-elevated p-2 font-mono text-xs/5 text-toned"
                          >{{ renderToolOutput(part.tool) }}</pre>
                          <p v-else class="italic text-muted">
                            No output
                          </p>
                        </UChatTool>
                      </div>
                    </template>
                  </UCollapsible>
                  <Suspense
                    v-if="renderedMessageContent(content, message)"
                  >
                    <Comark
                      :key="renderedMessageKey(content, message)"
                      class="text-sm/5 text-pretty [&_code]:rounded [&_code]:bg-elevated [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-elevated [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5"
                    >
                      {{ renderedMessageContent(content, message) }}
                    </Comark>
                  </Suspense>
                </div>
              </template>
            </UChatMessages>
            <div v-else class="flex h-full items-center justify-center px-4 py-6">
              <UEmpty
                icon="i-lucide-message-square"
                size="xs"
                title="No messages yet."
                :ui="{
                  root: 'border-0 ring-0 shadow-none bg-transparent gap-2 p-0',
                  header: 'gap-1',
                  avatar: 'mb-0 size-9 text-base',
                  title: 'text-sm font-medium',
                }"
              />
            </div>
          </div>

          <footer class="shrink-0 border-t border-default bg-default px-2 py-1.5">
            <UAlert
              v-if="!connected"
              color="neutral"
              variant="soft"
              icon="i-lucide-info"
              :title="disconnectedStatusMessage"
              class="mb-1"
              :ui="{
                root: 'rounded-md bg-transparent !py-1 !pl-8 !pr-2 gap-0',
                icon: 'absolute left-3 top-1/2 size-3.5 -translate-y-1/2 opacity-70',
                wrapper: 'min-w-0',
                title: 'text-xs font-normal leading-5',
              }"
            />
            <UAlert
              v-if="error"
              color="error"
              variant="soft"
              icon="i-lucide-triangle-alert"
              :title="error"
              class="mb-1"
              :ui="{
                root: 'rounded-md bg-transparent !py-1 !pl-8 !pr-2 gap-0',
                icon: 'absolute left-3 top-1/2 size-3.5 -translate-y-1/2 opacity-80',
                wrapper: 'min-w-0',
                title: 'text-xs font-normal leading-5',
              }"
            />
            <form
              class="flex min-h-8 items-center gap-1 rounded-md bg-default px-2 py-1 shadow-xs ring-1 ring-default"
              @submit.prevent="submitComposer"
            >
              <textarea
                ref="promptInput"
                v-model="input"
                placeholder="Type a message..."
                rows="1"
                :disabled="status !== 'ready'"
                class="h-6 max-h-24 min-h-6 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-0 py-0 text-base/6 outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm/6"
                @keydown.enter.exact.prevent="send"
              />
              <UButton
                type="submit"
                :icon="status === 'ready' ? 'i-lucide-arrow-up' : 'i-lucide-square'"
                :disabled="status === 'ready' && !input.trim()"
                :aria-label="status === 'ready' ? 'Send message' : 'Stop response'"
                color="primary"
                size="xs"
                square
                class="shrink-0"
              />
            </form>
          </footer>
        </section>

        <button
          type="button"
          class="group hidden min-h-0 cursor-col-resize bg-border outline-none hover:bg-primary focus-visible:bg-primary md:block"
          aria-label="Resize integration panel"
          @pointerdown="startSidebarResize"
        >
          <span class="block h-full w-px bg-transparent group-hover:bg-primary" />
        </button>

        <aside class="min-h-0 border-t border-default p-1.5 md:border-l md:border-t-0 md:p-2">
          <UCard
            variant="outline"
            class="flex h-full min-h-0 flex-col"
            :ui="{
              root: 'rounded-md',
              header: 'p-2 sm:p-2',
              body: 'flex min-h-0 flex-1 flex-col p-1.5 sm:p-1.5',
            }"
          >
            <template #header>
              <div class="flex min-w-0 items-center justify-between gap-2">
                <div class="flex min-w-0 items-center gap-2">
                  <UIcon name="i-lucide-plug" class="size-4 shrink-0 text-muted" />
                  <span class="truncate text-sm font-medium">Integration</span>
                </div>
                <UBadge color="neutral" variant="soft" size="xs">
                  {{ state.selected || 'dev' }}
                </UBadge>
              </div>
            </template>

            <UTabs
              :items="integrationTabs"
              color="neutral"
              variant="pill"
              size="xs"
              class="flex min-h-0 flex-1 flex-col"
              :ui="{
                list: 'shrink-0 overflow-x-auto rounded-md p-0.5',
                trigger: 'min-h-7 flex-none shrink-0 whitespace-nowrap px-2',
                content: 'min-h-0 flex-1 overflow-y-auto pt-1.5',
              }"
            >
              <template #files>
                <UAlert
                  v-if="fileRows.length && metadataError"
                  color="error"
                  variant="soft"
                  icon="i-lucide-triangle-alert"
                  :title="metadataError"
                  class="mb-2"
                  :ui="{ root: 'rounded-md bg-transparent !py-1 !pl-8 !pr-2 gap-0', icon: 'absolute left-3 top-1/2 size-3.5 -translate-y-1/2 opacity-80', wrapper: 'min-w-0', title: 'text-xs font-normal leading-5' }"
                />
                <div
                  v-if="isMetadataLoading"
                  class="flex flex-col items-center gap-2 px-2 py-6 text-center"
                >
                  <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
                  <div>
                    <p class="text-sm font-medium text-toned">Loading workspace files.</p>
                    <p class="text-xs/5 text-muted">Inspecting workspace metadata for this chat.</p>
                  </div>
                </div>
                <div v-else-if="fileRows.length" class="space-y-1">
                  <UButton
                    v-for="file in fileRows"
                    :key="file.path"
                    :icon="file.kind === 'directory' ? (file.expanded ? 'i-lucide-folder-open' : 'i-lucide-folder') : 'i-lucide-file'"
                    :label="fileLabel(file)"
                    color="neutral"
                    :variant="selectedFilePath === file.path ? 'soft' : 'ghost'"
                    size="xs"
                    block
                    class="min-h-7 justify-start"
                    :style="{ paddingLeft: `${0.45 + file.depth * 0.9}rem` }"
                    :ui="{
                      leadingIcon: file.kind === 'directory' ? 'text-warning' : 'text-muted',
                      label: 'min-w-0 truncate text-left text-sm sm:text-xs',
                    }"
                    @click="toggleFile(file)"
                  >
                    <template #trailing>
                      <UBadge
                        v-if="fileMaterializationBadge(file)"
                        :color="fileMaterializationColor(file)"
                        variant="soft"
                        size="xs"
                        class="ml-auto shrink-0"
                      >
                        {{ fileMaterializationBadge(file) }}
                      </UBadge>
                    </template>
                  </UButton>
                </div>
                <UEmpty
                  v-else-if="metadataError"
                  icon="i-lucide-triangle-alert"
                  title="Workspace metadata failed."
                  :description="metadataError"
                  size="xs"
                  :ui="{ root: 'border-0 ring-0 shadow-none bg-transparent px-2 py-6' }"
                />
                <UEmpty
                  v-else
                  icon="i-lucide-folder-search"
                  title="No files exposed."
                  description="This chat has not registered workspace files for DevTools."
                  size="xs"
                  :ui="{ root: 'border-0 ring-0 shadow-none bg-transparent px-2 py-6' }"
                />
              </template>

              <template #tools>
                <UAlert
                  v-if="visibleTools.length && metadataError"
                  color="error"
                  variant="soft"
                  icon="i-lucide-triangle-alert"
                  :title="metadataError"
                  class="mb-2"
                  :ui="{ root: 'rounded-md bg-transparent !py-1 !pl-8 !pr-2 gap-0', icon: 'absolute left-3 top-1/2 size-3.5 -translate-y-1/2 opacity-80', wrapper: 'min-w-0', title: 'text-xs font-normal leading-5' }"
                />
                <div
                  v-if="isMetadataLoading"
                  class="flex flex-col items-center gap-2 px-2 py-6 text-center"
                >
                  <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
                  <div>
                    <p class="text-sm font-medium text-toned">Loading tools.</p>
                    <p class="text-xs/5 text-muted">Inspecting workspace metadata for this chat.</p>
                  </div>
                </div>
                <div v-else-if="visibleTools.length" class="space-y-1.5">
                  <div
                    v-for="tool in visibleTools"
                    :key="tool.name"
                    class="rounded-md border border-default bg-default/60 p-2"
                  >
                    <div class="flex min-w-0 items-start gap-2">
                      <UIcon :name="tool.icon || 'i-lucide-wrench'" class="mt-0.5 size-4 shrink-0 text-muted" />
                      <div class="min-w-0 flex-1">
                        <div class="flex min-w-0 items-center gap-2">
                          <UTooltip :text="tool.name">
                            <span class="truncate text-sm font-medium">{{ tool.name }}</span>
                          </UTooltip>
                          <UBadge
                            :color="toolStatusColor(tool)"
                            variant="soft"
                            size="xs"
                            class="ml-auto shrink-0 capitalize"
                          >
                            {{ toolStatus(tool) }}
                          </UBadge>
                        </div>
                        <p v-if="tool.description" class="mt-1 text-xs/5 text-muted">
                          {{ tool.description }}
                        </p>
                        <div v-if="tool.category || toolPresetLabel(tool)" class="mt-2 flex flex-wrap gap-1">
                          <UBadge v-if="tool.category" color="neutral" variant="outline" size="xs">
                            {{ tool.category }}
                          </UBadge>
                          <UBadge
                            v-if="toolPresetLabel(tool)"
                            color="primary"
                            variant="soft"
                            size="xs"
                          >
                            {{ toolPresetLabel(tool) }}
                          </UBadge>
                        </div>
                        <div v-if="tool.commands?.length" class="mt-2 flex flex-wrap gap-1">
                          <UBadge
                            v-for="command in tool.commands"
                            :key="command"
                            color="neutral"
                            variant="soft"
                            size="xs"
                          >
                            {{ command }}
                          </UBadge>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <UEmpty
                  v-else-if="metadataError"
                  icon="i-lucide-triangle-alert"
                  title="Workspace metadata failed."
                  :description="metadataError"
                  size="xs"
                  :ui="{ root: 'border-0 ring-0 shadow-none bg-transparent px-2 py-6' }"
                />
                <UEmpty
                  v-else
                  icon="i-lucide-wrench"
                  title="No tools exposed."
                  description="This chat has not registered tools for DevTools."
                  size="xs"
                  :ui="{ root: 'border-0 ring-0 shadow-none bg-transparent px-2 py-6' }"
                />
              </template>

              <template #instructions>
                <UAlert
                  v-if="state.instructions?.length && metadataError"
                  color="error"
                  variant="soft"
                  icon="i-lucide-triangle-alert"
                  :title="metadataError"
                  class="mb-2"
                  :ui="{ root: 'rounded-md bg-transparent !py-1 !pl-8 !pr-2 gap-0', icon: 'absolute left-3 top-1/2 size-3.5 -translate-y-1/2 opacity-80', wrapper: 'min-w-0', title: 'text-xs font-normal leading-5' }"
                />
                <div
                  v-if="isMetadataLoading"
                  class="flex flex-col items-center gap-2 px-2 py-6 text-center"
                >
                  <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
                  <div>
                    <p class="text-sm font-medium text-toned">Loading instructions.</p>
                    <p class="text-xs/5 text-muted">Inspecting workspace metadata for this chat.</p>
                  </div>
                </div>
                <div v-else-if="state.instructions?.length" class="min-w-0 space-y-3 px-1">
                  <div
                    v-for="(instruction, index) in state.instructions"
                    :key="index"
                  >
                    <div class="mb-1.5 flex items-center gap-2">
                      <UIcon name="i-lucide-scroll-text" class="size-4 shrink-0 text-muted" />
                      <span class="min-w-0 truncate text-sm font-medium">{{ instructionLabel(instruction) }}</span>
                      <UBadge color="neutral" variant="soft" size="xs" class="ml-auto shrink-0">
                        {{ index + 1 }}
                      </UBadge>
                    </div>
                    <Suspense>
                      <Comark class="max-w-full break-words text-xs/5 text-toned [&_code]:break-words [&_code]:rounded [&_code]:bg-elevated [&_code]:px-1 [&_h1]:mb-1.5 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-2.5 [&_h2]:text-sm [&_h2]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:rounded-md [&_pre]:bg-elevated [&_pre]:p-2 [&_strong]:text-highlighted [&_ul]:list-disc [&_ul]:pl-4">
                        {{ instructionContent(instruction) }}
                      </Comark>
                    </Suspense>
                  </div>
                </div>
                <UEmpty
                  v-else-if="metadataError"
                  icon="i-lucide-triangle-alert"
                  title="Workspace metadata failed."
                  :description="metadataError"
                  size="xs"
                  :ui="{ root: 'border-0 ring-0 shadow-none bg-transparent px-2 py-6' }"
                />
                <UEmpty
                  v-else
                  icon="i-lucide-scroll-text"
                  title="No instructions exposed."
                  description="This chat has not registered static system instructions for DevTools."
                  size="xs"
                  :ui="{ root: 'border-0 ring-0 shadow-none bg-transparent px-2 py-6' }"
                />
              </template>
            </UTabs>
          </UCard>
        </aside>
      </div>

    </main>
  </UApp>
</template>

<style>
html,
body,
#__nuxt {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

</style>
