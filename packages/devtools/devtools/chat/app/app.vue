<script setup lang="ts">
import { Comark } from "@comark/vue"
import { connectRemoteDevTools, getDevToolsRpcClient, parseRemoteConnection } from "@vitejs/devtools-kit/client"

import {
  chatDevtoolsClearRpc,
  chatDevtoolsGetStateRpc,
  chatDevtoolsSendRpc,
  chatDevtoolsStreamChannel,
  type ChatDevtoolsFileTreeItem,
  type ChatDevtoolsMessage,
  type ChatDevtoolsSendResult,
  type ChatDevtoolsStateResult,
  type ChatDevtoolsStreamEvent,
  type ChatDevtoolsTool,
  type ChatDevtoolsToolDefinition,
} from "../../../../agent/src/chat/devtools-shared"
import { resolveChatBridgeRoute } from "./bridge-route"

type ChatStatus = "ready" | "submitted" | "streaming" | "error"
type ChatMessage = {
  chat?: string
  content?: string
  createdAt?: string
  id: string
  loading?: boolean
  loadingText?: string
  role: "assistant" | "user"
  parts: Array<{ type: "tool", tool: ChatDevtoolsTool }>
}

const input = ref("")
const promptInput = ref<HTMLTextAreaElement>()
const status = ref<ChatStatus>("ready")
const error = ref<string | undefined>()
const connected = ref(false)
const activeRequest = ref<{ chat?: string, text: string } | undefined>()
const isBusy = computed(() => status.value !== "ready")
const previewFiles: ChatDevtoolsFileTreeItem[] = [
  {
    kind: "directory",
    label: "server",
    path: "server",
    children: [
      { kind: "file", path: "server/agents/support.ts", updatedAt: "Preview" },
    ],
  },
  {
    kind: "directory",
    label: "workspace",
    path: "workspace",
    children: [
      {
        kind: "directory",
        label: "forecastingEngine",
        materialize: "lazy",
        materialized: false,
        path: "workspace/forecasting-engine",
        source: "forecastingEngine",
        children: [
          {
            kind: "directory",
            label: "services",
            materialize: "lazy",
            materialized: false,
            path: "workspace/forecasting-engine/services",
            source: "forecastingEngine",
            children: [
              {
                kind: "file",
                label: "planning.md",
                materialize: "lazy",
                materialized: false,
                path: "workspace/forecasting-engine/services/planning.md",
                source: "forecastingEngine",
              },
            ],
          },
        ],
      },
      { kind: "file", path: "workspace/AGENTS.md", updatedAt: "Preview" },
    ],
  },
]
const previewInstructions = [
  {
    content: "# System instructions\n\n- Use the workspace forecast files before answering.\n- Explain the planning assumptions clearly.",
    label: "System instructions",
    source: "system",
  },
]
const previewTools: ChatDevtoolsToolDefinition[] = [
  {
    category: "workspace",
    commands: ["readonly()"],
    description: "Inspect workspace files from the ViteHub preset without mutating project state.",
    name: "shell",
    preset: "vitehub-workspace",
    status: "available",
  },
]
const state = ref<ChatDevtoolsStateResult>({
  chats: [],
  files: previewFiles,
  instructions: previewInstructions.map(instruction => instruction.content),
  selected: "",
  tools: previewTools,
})
const messages = ref<ChatMessage[]>([])
const chatMessages = computed(() => messages.value as never)
const pendingUserMessage = ref<ChatMessage | undefined>()
const pendingAssistantMessage = ref<ChatMessage | undefined>()
const pendingAssistantBaselineIds = ref<Set<string> | undefined>()
const expandedFilePaths = ref(new Set<string>())
const selectedFilePath = ref<string | undefined>()
const sidebarWidth = ref(340)
let rpcClient: Awaited<ReturnType<typeof getDevToolsRpcClient>> | undefined
let currentReader: { cancel: () => unknown } | undefined
let simulationRunId = 0
let stopSidebarResize: (() => void) | undefined

const standaloneStatusMessage = "Preview mode. Connect through Vite DevTools to inspect a real chat runtime."
const simulationDelayMs = 360
const integrationTabs = [
  { icon: "i-lucide-files", label: "Files", slot: "files" as const },
  { icon: "i-lucide-wrench", label: "Tools", slot: "tools" as const },
  { icon: "i-lucide-scroll-text", label: "Instructions", slot: "instructions" as const },
]

type FileRow = ChatDevtoolsFileTreeItem & { depth: number, expanded?: boolean }
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
const recentTools = computed(() => {
  const tools = new Map<string, ChatDevtoolsTool>()
  for (const message of messages.value) {
    for (const part of message.parts) {
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

function clearPendingMessages() {
  const pendingId = pendingUserMessage.value?.id
  const pendingAssistantId = pendingAssistantMessage.value?.id
  pendingUserMessage.value = undefined
  pendingAssistantMessage.value = undefined
  pendingAssistantBaselineIds.value = undefined
  messages.value = messages.value.filter(message => message.id !== pendingId && message.id !== pendingAssistantId)
}

function clearPendingAssistantMessage() {
  const pendingAssistantId = pendingAssistantMessage.value?.id
  pendingAssistantMessage.value = undefined
  pendingAssistantBaselineIds.value = undefined
  messages.value = messages.value.filter(message => message.id !== pendingAssistantId)
}

function selectedChat(next = state.value) {
  return next.chats.find(chat => chat.name === next.selected) || next.chats[0]
}

function applyState(next: ChatDevtoolsStateResult) {
  state.value = {
    files: next.files || [],
    instructions: next.instructions || [],
    tools: next.tools || [],
    ...next,
  }
  const chat = selectedChat(next)
  const forceLoadingMessageId = activeLoadingMessageId(chat?.name, chat?.messages || [])
  const serverMessages = (chat?.messages || []).map(message => toChatMessage(message, message.id === forceLoadingMessageId))
  const nextMessages = [...serverMessages]
  const pending = pendingUserMessage.value

  if (pending && pending.chat === chat?.name && serverMessages.some(message => message.role === "user" && message.content === pending.content)) {
    pendingUserMessage.value = undefined
  }
  else if (pending && pending.chat === chat?.name && !serverMessages.some(message => message.id === pending.id)) {
    nextMessages.push(pending)
  }
  else {
    pendingUserMessage.value = undefined
  }

  const pendingAssistant = pendingAssistantMessage.value
  if (pendingAssistant && pendingAssistant.chat === chat?.name) {
    const baselineIds = pendingAssistantBaselineIds.value
    const hasServerAssistant = serverMessages.some(message =>
      message.role === "assistant"
      && message.id !== pendingAssistant.id
      && !baselineIds?.has(message.id),
    )
    if (!hasServerAssistant && !nextMessages.some(message => message.id === pendingAssistant.id)) {
      nextMessages.push(pendingAssistant)
    }
    else {
      pendingAssistantMessage.value = undefined
      pendingAssistantBaselineIds.value = undefined
    }
  }

  messages.value = nextMessages
  syncExpandedFiles(state.value.files || [])

}

function activeLoadingMessageId(chatName: string | undefined, rawMessages: ChatDevtoolsMessage[]) {
  const active = activeRequest.value
  if (!active || status.value === "ready") return undefined
  if (active.chat && active.chat !== chatName) return undefined

  const userIndex = rawMessages.findLastIndex(message => message.role === "user" && message.text === active.text)
  if (userIndex < 0) return undefined

  return rawMessages.slice(userIndex + 1).find(message =>
    message.role === "assistant"
    && (message.loading || isGenericAssistantText(message.text)),
  )?.id
}

function applyStreamEvent(event: ChatDevtoolsStreamEvent) {
  if (event.type === "state") {
    applyState(event.state)
    return
  }
  if (event.type === "error") {
    clearPendingAssistantMessage()
    error.value = event.message
  }
}

function hasCompletedResponse(next: ChatDevtoolsStateResult, chatName: string | undefined, text: string) {
  const chat = (chatName ? next.chats.find(item => item.name === chatName) : undefined) || next.chats[0]
  const messages = chat?.messages || []
  const userIndex = messages.findLastIndex(message => message.role === "user" && message.text === text)
  if (userIndex < 0) return false

  return messages.slice(userIndex + 1).some(message =>
    message.role === "assistant"
    && !message.loading
    && !!message.text,
  )
}

function hasCurrentUserMessage(next: ChatDevtoolsStateResult, chatName: string | undefined, text: string) {
  const chat = (chatName ? next.chats.find(item => item.name === chatName) : undefined) || next.chats[0]
  return (chat?.messages || []).some(message => message.role === "user" && message.text === text)
}

function toChatMessage(message: ChatDevtoolsMessage, forceLoading = false): ChatMessage {
  const genericAssistantText = message.role === "assistant" && isGenericAssistantText(message.text)
  const loading = forceLoading || Boolean(message.loading) || (genericAssistantText && !(message.tools || []).length)
  return {
    content: loading || genericAssistantText ? undefined : message.text || undefined,
    createdAt: message.createdAt,
    id: message.id,
    loading,
    loadingText: loading ? (genericAssistantText ? undefined : message.text) || "Thinking..." : undefined,
    role: message.role === "assistant" ? "assistant" : "user",
    parts: (message.tools || []).filter(tool => !isConversationalEchoTool(tool)).map(tool => ({ type: "tool", tool })),
  }
}

function renderedMessageContent(content: unknown, message: { content?: unknown }) {
  return typeof content === "string" && content.trim()
    ? content
    : typeof message.content === "string" && message.content.trim()
      ? message.content
      : undefined
}

function isGenericAssistantText(text: string): boolean {
  const normalized = text.trim()
  return !normalized || normalized === "..." || normalized === "Thinking..."
}

function commandFromTool(tool: ChatDevtoolsTool) {
  const input = tool.input && typeof tool.input === "object" ? tool.input as Record<string, unknown> : {}
  return typeof input.command === "string" ? input.command.trim() : undefined
}

function hasUnsupportedShellOutput(output: unknown): boolean {
  if (typeof output === "string") {
    return output.includes("Unsupported shell syntax:")
      || output.includes("Unsupported workspace shell command:")
  }
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>
    return hasUnsupportedShellOutput(record.stderr) || hasUnsupportedShellOutput(record.stdout)
  }
  return false
}

function isConversationalEchoTool(tool: ChatDevtoolsTool) {
  const command = commandFromTool(tool)
  return tool.name === "shell"
    && !!command
    && /^echo(?:\s|$)/.test(command)
    && hasUnsupportedShellOutput(tool.output)
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
  const expanded = new Set(expandedFilePaths.value)
  const isInitialExpansion = expanded.size === 0
  const visit = (items: ChatDevtoolsFileTreeItem[]) => {
    for (const file of items) {
      if (file.kind !== "directory") continue
      if (file.path === "" || file.path === "/" || isInitialExpansion) {
        expanded.add(file.path)
      }
      if (isInitialExpansion) {
        visit(file.children || [])
      }
    }
  }
  visit(files)
  expandedFilePaths.value = expanded
}

function flattenFiles(files: ChatDevtoolsFileTreeItem[], expanded: Set<string>, depth = 0): FileRow[] {
  return files.flatMap((file) => {
    const isExpanded = file.kind === "directory" && expanded.has(file.path)
    return [
      { ...file, depth, expanded: isExpanded },
      ...(isExpanded ? flattenFiles(file.children || [], expanded, depth + 1) : []),
    ]
  })
}

function fileLabel(file: ChatDevtoolsFileTreeItem) {
  return file.label || file.path.split("/").filter(Boolean).at(-1) || file.path || "workspace"
}

function toggleFile(file: ChatDevtoolsFileTreeItem) {
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

function fileMaterialization(file: ChatDevtoolsFileTreeItem): "lazy" | "materialized" | undefined {
  const meta = file as ChatDevtoolsFileTreeItem & FileMaterialization
  if (meta.status === "ready" || meta.materialized || meta.materializedAt) return "materialized"
  if (meta.status === "lazy" || (meta.materialized === false && meta.materialize === "lazy")) return "lazy"
  return undefined
}

function isLazyFile(file: ChatDevtoolsFileTreeItem) {
  return fileMaterialization(file) === "lazy" && Boolean((file as ChatDevtoolsFileTreeItem & FileMaterialization).source)
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
    sidebarWidth.value = Math.min(560, Math.max(280, window.innerWidth - moveEvent.clientX))
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
  return Boolean((message as ChatMessage | undefined)?.loading)
}

function loadingMessageText(message: unknown) {
  return (message as ChatMessage | undefined)?.loadingText || "Thinking..."
}

function chatToolParts(parts: unknown): Array<{ type: "tool", tool: ChatDevtoolsTool }> {
  return Array.isArray(parts)
    ? parts.filter((part): part is { type: "tool", tool: ChatDevtoolsTool } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "tool" && "tool" in part)
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
  const createdAt = Date.parse((message as ChatMessage | undefined)?.createdAt || "")
  if (!Number.isFinite(createdAt)) return undefined

  const toolTimes = chatToolParts(parts)
    .map(part => Date.parse(part.tool.updatedAt))
    .filter(Number.isFinite)
  const endedAt = toolTimes.length ? Math.max(...toolTimes) : Date.now()
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
    return loadingMessageText(message)
  }
  return toolsSummary(message, parts)
}

function appendDummy(message: ChatDevtoolsMessage) {
  messages.value = [...messages.value, toChatMessage(message)]
}

function appendOrUpdateMessage(message: ChatMessage) {
  const index = messages.value.findIndex(item => item.id === message.id)
  if (index >= 0) {
    messages.value = messages.value.map(item => item.id === message.id ? message : item)
    return
  }
  messages.value = [...messages.value, message]
}

function appendPendingUserMessage(text: string, chat: string | undefined) {
  pendingUserMessage.value = {
    chat,
    content: text,
    id: `pending-user-${Date.now()}`,
    role: "user",
    parts: [],
  }
  messages.value = [...messages.value, pendingUserMessage.value]
}

function appendPendingAssistantMessage(chat: string | undefined) {
  pendingAssistantBaselineIds.value = new Set((selectedChat()?.messages || [])
    .filter(message => message.role === "assistant")
    .map(message => message.id))
  pendingAssistantMessage.value = {
    chat,
    id: `pending-assistant-${Date.now()}`,
    loading: true,
    role: "assistant",
    parts: [],
  }
  messages.value = [...messages.value, pendingAssistantMessage.value]
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForFrame() {
  return new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
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

async function runStandaloneSimulation(text: string) {
  const runId = ++simulationRunId
  const isCurrentRun = () => runId === simulationRunId
  const now = Date.now()
  state.value = {
    chats: state.value.chats.length ? state.value.chats : [{ name: "preview", messages: [] }],
    files: previewFiles,
    selected: state.value.selected || "preview",
    instructions: previewInstructions.map(instruction => instruction.content),
    tools: previewTools,
  }
  const assistant: ChatMessage = {
    id: `assistant-${now}`,
    loading: true,
    role: "assistant",
    parts: [],
  }
  appendDummy({
    id: `user-${now}`,
    role: "user",
    text,
    createdAt: new Date().toISOString(),
  })
  appendOrUpdateMessage(assistant)
  status.value = "streaming"

  const tools: ChatDevtoolsTool[] = [
    {
      id: `tool-${now}-workspace-search`,
      input: {
        command: `rg -n ${JSON.stringify(text)} data-sources`,
      },
      name: "shell",
      status: "running",
      text: "shell",
      updatedAt: new Date().toISOString(),
    },
    {
      id: `tool-${now}-read-file`,
      input: {
        command: "cat data-sources/AGENTS.md",
      },
      name: "shell",
      status: "running",
      text: "shell",
      updatedAt: new Date().toISOString(),
    },
  ]

  await wait(simulationDelayMs)
  if (!isCurrentRun()) return
  assistant.parts = [{ type: "tool", tool: tools[0]! }]
  appendOrUpdateMessage({ ...assistant, parts: [...assistant.parts] })

  await wait(simulationDelayMs)
  if (!isCurrentRun()) return
  tools[0] = {
    ...tools[0]!,
    output: {
      exitCode: 0,
      stderr: "",
      stdout: [
        "data-sources/README.md:4:Repository inventory and workspace guidance",
        "data-sources/forecasts.md:12:Forecasting and portal data source notes",
        "",
      ].join("\n"),
    },
    status: "completed",
    updatedAt: new Date().toISOString(),
  }
  assistant.parts = [{ type: "tool", tool: tools[0]! }]
  appendOrUpdateMessage({ ...assistant, parts: [...assistant.parts] })

  await wait(simulationDelayMs)
  if (!isCurrentRun()) return
  assistant.parts = [
    { type: "tool", tool: tools[0]! },
    { type: "tool", tool: tools[1]! },
  ]
  appendOrUpdateMessage({ ...assistant, parts: [...assistant.parts] })

  await wait(simulationDelayMs)
  if (!isCurrentRun()) return
  tools[1] = {
    ...tools[1]!,
    output: {
      exitCode: 0,
      stderr: "",
      stdout: [
        "# Quiver Chat Workspace",
        "",
        "Use workspace sources first. Keep shell inspection read-only unless a workflow explicitly enables writes.",
        "",
      ].join("\n"),
    },
    status: "completed",
    updatedAt: new Date().toISOString(),
  }
  assistant.parts = [
    { type: "tool", tool: tools[0]! },
    { type: "tool", tool: tools[1]! },
  ]
  assistant.content = ""
  assistant.loading = false
  appendOrUpdateMessage({ ...assistant, parts: [...assistant.parts] })

  const chunks = [
    "I found the relevant workspace notes and traced the request through the Quiver Chat data sources. ",
    "The likely next step is to answer from the repository context first, then cite which workspace files or source records were used. ",
    "In a connected Vite DevTools session this same panel will show live Chat SDK tool calls alongside the answer.",
  ]
  for (const chunk of chunks) {
    await wait(simulationDelayMs)
    if (!isCurrentRun()) return
    assistant.content += chunk
    appendOrUpdateMessage({ ...assistant, parts: [...assistant.parts] })
  }

  if (!isCurrentRun()) return
  error.value = undefined
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

async function callBridgeState(body: Record<string, unknown>): Promise<ChatDevtoolsStateResult | undefined> {
  try {
    const response = await fetch(localBridgeRoute(), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(body),
    })
    if (!response.ok) return undefined

    connected.value = true
    return await response.json() as ChatDevtoolsStateResult
  }
  catch {
    return undefined
  }
}

async function refresh() {
  if (!shouldPreferRpcBridge()) {
    const bridgeState = await callBridgeState({ action: "get-state" })
    if (bridgeState) {
      applyState(bridgeState)
      error.value = undefined
      return
    }
  }

  try {
    applyState(await callRpc<ChatDevtoolsStateResult>(chatDevtoolsGetStateRpc))
    error.value = undefined
  }
  catch (cause) {
    connected.value = false
    error.value = cause instanceof Error ? cause.message : "Open this page from Vite DevTools to connect to your local chat."
  }
}

async function refreshFromBridge(chat?: string) {
  if (shouldPreferRpcBridge()) {
    await refresh()
    return
  }

  const bridgeState = await callBridgeState({ action: "get-state", ...(chat ? { chat } : {}) })
  if (bridgeState) {
    applyState(bridgeState)
    error.value = undefined
    return
  }
  await refresh()
}

async function pollFinalBridgeState(input: { chat?: string, text: string }, signal: AbortSignal) {
  while (!signal.aborted) {
    await new Promise(resolve => setTimeout(resolve, 700))
    if (signal.aborted) break

    try {
      const response = await fetch(localBridgeRoute(), {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ action: "get-state", ...(input.chat ? { chat: input.chat } : {}) }),
        signal,
      })
      if (!response.ok) continue

      const next = await response.json() as ChatDevtoolsStateResult
      if (hasCurrentUserMessage(next, input.chat, input.text)) {
        applyState(next)
        error.value = undefined
      }
      if (hasCompletedResponse(next, input.chat, input.text)) {
        status.value = "ready"
        activeRequest.value = undefined
        applyState(next)
        return true
      }
    }
    catch {
      if (signal.aborted) break
    }
  }

  return false
}

async function pollFinalRpcState(input: { chat?: string, text: string }, signal: AbortSignal) {
  while (!signal.aborted) {
    await new Promise(resolve => setTimeout(resolve, 700))
    if (signal.aborted) break

    try {
      const next = await callRpc<ChatDevtoolsStateResult>(chatDevtoolsGetStateRpc)
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

async function recoverBridgeState(input: { chat?: string, text: string }) {
  const abortController = new AbortController()
  const startedAt = Date.now()
  const timeout = setTimeout(() => abortController.abort(), 60_000)
  let sawSubmittedMessage = false

  try {
    while (!abortController.signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 700))
      if (abortController.signal.aborted) break

      try {
        const response = await fetch(localBridgeRoute(), {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: JSON.stringify({ action: "get-state", ...(input.chat ? { chat: input.chat } : {}) }),
          signal: abortController.signal,
        })
        if (!response.ok) continue

        const next = await response.json() as ChatDevtoolsStateResult
        if (hasCurrentUserMessage(next, input.chat, input.text)) {
          sawSubmittedMessage = true
          applyState(next)
          error.value = undefined
        }
        if (hasCompletedResponse(next, input.chat, input.text)) {
          return true
        }
      }
      catch {
        if (abortController.signal.aborted) break
      }

      if (!sawSubmittedMessage && Date.now() - startedAt > 3_000) {
        return false
      }
    }
  }
  finally {
    clearTimeout(timeout)
  }

  return false
}

function watchBridgeState(input: { chat?: string, text: string }) {
  let stopped = false

  const loadNextState = async () => {
    const bridgeAbort = new AbortController()
    const bridgeTimeout = setTimeout(() => bridgeAbort.abort(), 2_000)
    try {
      const response = await fetch(localBridgeRoute(), {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ action: "get-state", ...(input.chat ? { chat: input.chat } : {}) }),
        signal: bridgeAbort.signal,
      })
      if (response.ok) return await response.json() as ChatDevtoolsStateResult
    }
    catch {
      // Fall through to the RPC transport.
    }
    finally {
      clearTimeout(bridgeTimeout)
    }

    try {
      return await Promise.race([
        callRpc<ChatDevtoolsStateResult>(chatDevtoolsGetStateRpc),
        new Promise<undefined>(resolve => setTimeout(resolve, 2_000)),
      ])
    }
    catch {
      return undefined
    }
  }

  void (async () => {
    while (!stopped) {
      await new Promise(resolve => setTimeout(resolve, 700))
      if (stopped) break

      const next = await loadNextState()
      if (!next || !hasCurrentUserMessage(next, input.chat, input.text)) continue

      applyState(next)
      error.value = undefined

      if (hasCompletedResponse(next, input.chat, input.text)) {
        stopped = true
        currentReader?.cancel()
        status.value = "ready"
        activeRequest.value = undefined
        applyState(next)
        break
      }
    }
  })()

  return () => {
    stopped = true
  }
}

async function readDirectBridgeStream(input: { chat?: string, text: string }): Promise<boolean> {
  const abortController = new AbortController()
  currentReader = { cancel: () => abortController.abort() }

  let response: Response | undefined
  try {
    response = await Promise.race([
      fetch(localBridgeRoute(), {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ action: "send", ...input, stream: true }),
        signal: abortController.signal,
      }),
      new Promise<undefined>(resolve => setTimeout(resolve, 2_000)),
    ])
  }
  catch {
    currentReader = undefined
    return false
  }

  if (!response) {
    const recovered = await recoverBridgeState(input)
    abortController.abort()
    currentReader = undefined
    return recovered
  }

  if (!response.ok || !response.body) {
    currentReader = undefined
    return false
  }

  connected.value = true
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""

  const readStream = async () => {
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
          if (event.type === "error" || event.type === "done") return true
        }
      }

      const tail = pending.trim()
      if (tail) {
        applyStreamEvent(JSON.parse(tail) as ChatDevtoolsStreamEvent)
      }
      return true
    }
    catch {
      return abortController.signal.aborted
    }
  }

  try {
    const completed = await Promise.race([
      readStream(),
      pollFinalBridgeState(input, abortController.signal),
    ])
    if (!completed || hasCompletedResponse(state.value, input.chat, input.text)) {
      return completed
    }

    return await pollFinalBridgeState(input, abortController.signal)
  }
  finally {
    abortController.abort()
    currentReader = undefined
  }
}

async function readRpcStream(streamId: string, input: { chat?: string, text: string }) {
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
      if (event.type === "error" || event.type === "done") return true
    }
    return true
  }

  try {
    return await Promise.race([
      readStream(),
      pollFinalRpcState(input, abortController.signal),
    ])
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
  activeRequest.value = { text }
  error.value = undefined
  let chat: string | undefined
  let shouldRefreshFinalState = false
  let stopBridgeWatch: (() => void) | undefined

  try {
    chat = selectedChat()?.name
    activeRequest.value = { ...(chat ? { chat } : {}), text }
    currentReader?.cancel()
    currentReader = undefined
    appendPendingUserMessage(text, chat)
    await nextTick()
    await waitForFrame()
    status.value = "streaming"
    stopBridgeWatch = watchBridgeState({ ...(chat ? { chat } : {}), text })

    const bridgeInput = { ...(chat ? { chat } : {}), text }
    if (!shouldPreferRpcBridge()) {
      if (await readDirectBridgeStream(bridgeInput)) {
        status.value = "ready"
        activeRequest.value = undefined
        await refreshFromBridge(chat)
        return
      }
    }

    const result = await callRpc<ChatDevtoolsSendResult>(chatDevtoolsSendRpc, {
      ...(chat ? { chat } : {}),
      text,
    })
    if (!result.streamId) {
      applyState(result)
      status.value = "ready"
      return
    }

    await readRpcStream(result.streamId, { ...(chat ? { chat } : {}), text })
    shouldRefreshFinalState = true
  }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : "Chat DevTools send failed."
    if (connected.value) {
      clearPendingAssistantMessage()
      error.value = message
      return
    }

    clearPendingMessages()
    if (await recoverBridgeState({ ...(chat ? { chat } : {}), text })) {
      return
    }
    await runStandaloneSimulation(text)
  }
  finally {
    stopBridgeWatch?.()
    currentReader = undefined
    if (shouldRefreshFinalState) {
      status.value = "ready"
      activeRequest.value = undefined
      await refreshFromBridge(chat)
    }
    activeRequest.value = undefined
    status.value = "ready"
  }
}

function stop() {
  currentReader?.cancel()
  currentReader = undefined
  activeRequest.value = undefined
  pendingAssistantMessage.value = undefined
  pendingAssistantBaselineIds.value = undefined
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
  simulationRunId++
  try {
    currentReader?.cancel()
    currentReader = undefined
    pendingUserMessage.value = undefined
    pendingAssistantMessage.value = undefined
    const bridgeState = await callBridgeState({ action: "clear", chat: state.value.selected })
    applyState(bridgeState || await callRpc<ChatDevtoolsStateResult>(chatDevtoolsClearRpc, {
        chat: state.value.selected,
      }))
    error.value = undefined
  }
  catch {
    state.value = {
      chats: [{ name: state.value.selected || "dev", messages: [] }],
      files: state.value.files || [],
      instructions: state.value.instructions || [],
      selected: state.value.selected || "dev",
      tools: state.value.tools || [],
    }
    pendingUserMessage.value = undefined
    pendingAssistantMessage.value = undefined
    messages.value = []
    error.value = undefined
    status.value = "ready"
  }
}

onMounted(() => {
  syncExpandedFiles(state.value.files || [])
  refresh()
})
onBeforeUnmount(() => stopSidebarResize?.())
</script>

<template>
  <UApp>
    <main class="fixed inset-0 isolate flex min-h-0 flex-col overflow-hidden bg-default text-default antialiased">
      <UIcon name="i-lucide-terminal" class="hidden" />
      <header class="flex h-[45px] shrink-0 items-center justify-between border-b border-default px-4">
        <h1 class="text-base font-semibold">
          ViteHub Chat
        </h1>
        <UButton
          icon="i-lucide-trash-2"
          label="Clear"
          color="neutral"
          variant="outline"
          size="sm"
          @click="clear"
        />
      </header>

      <div class="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_1px_minmax(280px,var(--chat-devtools-sidebar-width))]" :style="splitterStyle">
        <section class="relative flex min-h-0 flex-col overflow-hidden">
          <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-14">
            <UChatMessages
              v-if="messages.length"
              :messages="chatMessages"
              :should-auto-scroll="status === 'streaming'"
              compact
              class="min-h-full px-3 py-2"
            >
              <template #content="{ content, message, parts }">
                <div class="flex min-w-0 flex-col gap-2 text-sm/5">
                  <UCollapsible
                    v-if="isLoadingMessage(message) || hasToolParts(parts)"
                    :default-open="isLoadingMessage(message) || hasRunningTool(parts)"
                    :unmount-on-hide="false"
                    :ui="{
                      root: 'min-w-0',
                      content: 'overflow-hidden',
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
                      <div class="flex min-w-0 flex-col gap-2 px-px pb-px pt-2 text-xs/5">
                        <UChatTool
                          v-for="part in chatToolParts(parts)"
                          :key="part.tool.id"
                          :icon="toolIcon(part.tool)"
                          :text="renderToolCommand(part.tool)"
                          :streaming="part.tool.status === 'running'"
                          variant="card"
                          :default-open="false"
                          :ui="{
                            root: 'min-w-0 rounded-md',
                            trigger: 'min-h-7 px-2 py-1 text-xs focus-visible:ring-1 focus-visible:ring-muted focus-visible:outline-none',
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
                          <Suspense v-if="hasToolOutput(part.tool)">
                            <Comark class="space-y-1 text-toned [&_em]:text-muted [&_h3]:font-medium [&_h3]:text-highlighted [&_p]:my-0 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-elevated [&_pre]:p-2">
                              {{ renderToolOutput(part.tool) }}
                            </Comark>
                          </Suspense>
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
                    <Comark class="text-sm/5 text-pretty [&_code]:rounded [&_code]:bg-elevated [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-elevated [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5">
                      {{ renderedMessageContent(content, message) }}
                    </Comark>
                  </Suspense>
                </div>
              </template>
            </UChatMessages>
            <div v-else class="flex h-full items-center justify-center px-4">
              <UEmpty
                icon="i-lucide-message-square"
                title="No messages yet."
                :ui="{ root: 'border-0 ring-0 shadow-none bg-transparent' }"
              />
            </div>
          </div>

          <footer class="absolute inset-x-0 bottom-0 z-20 border-t border-default bg-default px-2 py-2">
            <UAlert
              v-if="!connected"
              color="neutral"
              variant="soft"
              icon="i-lucide-info"
              :title="standaloneStatusMessage"
              class="mb-1"
              :ui="{
                root: 'rounded-md bg-transparent !py-1 !pl-8 !pr-2 gap-0',
                icon: 'absolute left-3 top-1/2 size-3.5 -translate-y-1/2 opacity-70',
                wrapper: 'min-w-0',
                title: 'text-xs font-normal leading-5',
              }"
            />
            <form
              class="flex min-h-9 items-center gap-1 rounded-md border border-default bg-default px-2 py-1 shadow-xs"
              @submit.prevent="submitComposer"
            >
              <textarea
                ref="promptInput"
                v-model="input"
                placeholder="Type a message..."
                rows="1"
                :disabled="status !== 'ready'"
                class="h-6 max-h-24 min-h-6 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-0 py-0 text-sm/6 outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60"
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
          class="group hidden min-h-0 cursor-col-resize bg-border outline-none transition-colors hover:bg-primary focus-visible:bg-primary lg:block"
          aria-label="Resize integration panel"
          @pointerdown="startSidebarResize"
        >
          <span class="block h-full w-px bg-transparent group-hover:bg-primary" />
        </button>

        <aside class="hidden min-h-0 border-l border-default p-2 lg:block">
          <UCard
            variant="subtle"
            class="flex h-full min-h-0 flex-col"
            :ui="{
              root: 'rounded-lg',
              body: 'flex min-h-0 flex-1 flex-col p-2 sm:p-2',
            }"
          >
            <template #header>
              <div class="flex min-w-0 items-center justify-between gap-2">
                <div class="flex min-w-0 items-center gap-2">
                  <UIcon name="i-lucide-plug" class="size-4 shrink-0 text-muted" />
                  <span class="truncate text-sm font-medium">Integration</span>
                </div>
                <UBadge color="neutral" variant="soft" size="sm">
                  {{ state.selected || 'dev' }}
                </UBadge>
              </div>
            </template>

            <UTabs
              :items="integrationTabs"
              class="flex min-h-0 flex-1 flex-col"
              :ui="{
                list: 'shrink-0',
                content: 'min-h-0 flex-1 overflow-y-auto pt-2',
              }"
            >
              <template #files>
                <div v-if="fileRows.length" class="space-y-1">
                  <UButton
                    v-for="file in fileRows"
                    :key="file.path"
                    :icon="file.kind === 'directory' ? (file.expanded ? 'i-lucide-folder-open' : 'i-lucide-folder') : 'i-lucide-file'"
                    :label="fileLabel(file)"
                    color="neutral"
                    :variant="selectedFilePath === file.path ? 'soft' : 'ghost'"
                    size="sm"
                    block
                    class="justify-start"
                    :style="{ paddingLeft: `${0.5 + file.depth * 1.1}rem` }"
                    :ui="{
                      leadingIcon: file.kind === 'directory' ? 'text-warning' : 'text-muted',
                      label: 'min-w-0 truncate text-left',
                    }"
                    @click="toggleFile(file)"
                  >
                    <template #trailing>
                      <UBadge
                        v-if="isLazyFile(file)"
                        color="warning"
                        variant="soft"
                        size="sm"
                        class="ml-auto shrink-0"
                      >
                        Lazy
                      </UBadge>
                    </template>
                  </UButton>
                </div>
                <UEmpty
                  v-else
                  icon="i-lucide-folder-search"
                  title="No files exposed."
                  description="This chat has not registered workspace files for DevTools."
                  :ui="{ root: 'border-0 ring-0 shadow-none bg-transparent px-2 py-8' }"
                />
              </template>

              <template #tools>
                <div v-if="visibleTools.length" class="space-y-2">
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
                            size="sm"
                            class="ml-auto shrink-0 capitalize"
                          >
                            {{ toolStatus(tool) }}
                          </UBadge>
                        </div>
                        <p v-if="tool.description" class="mt-1 text-xs/5 text-muted">
                          {{ tool.description }}
                        </p>
                        <div v-if="tool.category || toolPresetLabel(tool)" class="mt-2 flex flex-wrap gap-1">
                          <UBadge v-if="tool.category" color="neutral" variant="outline" size="sm">
                            {{ tool.category }}
                          </UBadge>
                          <UBadge
                            v-if="toolPresetLabel(tool)"
                            color="primary"
                            variant="soft"
                            size="sm"
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
                            size="sm"
                          >
                            {{ command }}
                          </UBadge>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <UEmpty
                  v-else
                  icon="i-lucide-wrench"
                  title="No tools exposed."
                  description="This chat has not registered tools for DevTools."
                  :ui="{ root: 'border-0 ring-0 shadow-none bg-transparent px-2 py-8' }"
                />
              </template>

              <template #instructions>
                <div v-if="state.instructions?.length" class="min-w-0 space-y-4 px-1">
                  <div
                    v-for="(instruction, index) in state.instructions"
                    :key="index"
                  >
                    <div class="mb-2 flex items-center gap-2">
                      <UIcon name="i-lucide-scroll-text" class="size-4 text-muted" />
                      <span class="min-w-0 truncate text-sm font-medium">{{ instructionLabel(instruction) }}</span>
                      <UBadge color="neutral" variant="soft" size="sm" class="ml-auto">
                        {{ index + 1 }}
                      </UBadge>
                    </div>
                    <Suspense>
                      <Comark class="max-w-full break-words text-sm/6 text-toned [&_code]:break-words [&_code]:rounded [&_code]:bg-elevated [&_code]:px-1 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:rounded-md [&_pre]:bg-elevated [&_pre]:p-2 [&_strong]:text-highlighted [&_ul]:list-disc [&_ul]:pl-4">
                        {{ instructionContent(instruction) }}
                      </Comark>
                    </Suspense>
                  </div>
                </div>
                <UEmpty
                  v-else
                  icon="i-lucide-scroll-text"
                  title="No instructions exposed."
                  description="This chat has not registered static system instructions for DevTools."
                  :ui="{ root: 'border-0 ring-0 shadow-none bg-transparent px-2 py-8' }"
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
