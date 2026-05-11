<script setup lang="ts">
import { Comark } from "@comark/vue"
import { connectRemoteDevTools, getDevToolsRpcClient } from "@vitejs/devtools-kit/client"

import {
  chatDevtoolsClearRpc,
  chatDevtoolsBridgeRoute,
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
} from "../../../../chat/src/devtools-shared"

type ChatStatus = "ready" | "submitted" | "streaming" | "error"
type ChatMessage = {
  chat?: string
  content?: string
  id: string
  loading?: boolean
  role: "assistant" | "user"
  parts: Array<{ type: "tool", tool: ChatDevtoolsTool }>
}

const input = ref("")
const status = ref<ChatStatus>("ready")
const error = ref<string | undefined>()
const connected = ref(false)
const state = ref<ChatDevtoolsStateResult>({
  chats: [],
  files: [],
  instructions: [],
  selected: "",
  tools: [],
})
const messages = ref<ChatMessage[]>([])
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
  const serverMessages = (chat?.messages || []).map(toChatMessage)
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

function toChatMessage(message: ChatDevtoolsMessage): ChatMessage {
  const loading = message.role === "assistant" && message.text.trim() === "Thinking..." && !(message.tools || []).length
  return {
    content: loading ? undefined : message.text || undefined,
    id: message.id,
    loading,
    role: message.role === "assistant" ? "assistant" : "user",
    parts: (message.tools || []).filter(tool => !isConversationalEchoTool(tool)).map(tool => ({ type: "tool", tool })),
  }
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
  for (const file of files) {
    if (file.kind === "directory" && (file.path === "" || file.path === "/" || isInitialExpansion)) {
      expanded.add(file.path)
    }
  }
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
  if (meta.materialized || meta.materializedAt) return "materialized"
  if (meta.materialized === false || meta.materialize === "lazy" || meta.source) return "lazy"
  return undefined
}

function fileMaterializationLabel(file: ChatDevtoolsFileTreeItem) {
  return fileMaterialization(file) === "lazy" ? "Lazy" : "Ready"
}

function fileTrailing(file: ChatDevtoolsFileTreeItem) {
  return file.updatedAt
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

async function runStandaloneSimulation(text: string) {
  const runId = ++simulationRunId
  const isCurrentRun = () => runId === simulationRunId
  const now = Date.now()
  state.value = {
    chats: state.value.chats.length ? state.value.chats : [{ name: "preview", messages: [] }],
    files: [
      {
        kind: "directory",
        label: "server",
        path: "server",
        children: [
          { kind: "file", path: "server/chat.ts", updatedAt: "Preview" },
          { kind: "file", path: "server/agents/support.ts", updatedAt: "Preview" },
        ],
      },
      {
        kind: "directory",
        label: "data-sources",
        path: "data-sources",
        children: [
          { kind: "file", path: "data-sources/AGENTS.md", updatedAt: "Preview" },
          { kind: "file", path: "data-sources/README.md", updatedAt: "Preview" },
        ],
      },
    ],
    selected: state.value.selected || "preview",
    instructions: [
      [
        "Answer from the workspace files.",
        "Inspect relevant files before answering.",
        "If the files do not contain the answer, say what is missing and name what you checked.",
      ].join("\n"),
    ],
    tools: [
      {
        category: "workspace",
        commands: ["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc"],
        description: "Run an allowed workspace inspection command.",
        icon: "i-lucide-terminal",
        name: "shell",
        status: "available",
      },
    ],
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
    try {
      rpcClient = await getDevToolsRpcClient()
    }
    catch {
      rpcClient = await connectRemoteDevTools()
    }
  }
  connected.value = true
  return await rpcClient.call(method, ...args) as T
}

async function readDirectBridgeStream(input: { chat?: string, text: string }): Promise<boolean> {
  const abortController = new AbortController()
  currentReader = { cancel: () => abortController.abort() }

  let response: Response
  try {
    response = await fetch(chatDevtoolsBridgeRoute, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "send", ...input, stream: true }),
      signal: abortController.signal,
    })
  }
  catch {
    currentReader = undefined
    return false
  }

  if (!response.ok || !response.body) {
    currentReader = undefined
    return false
  }

  connected.value = true
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""

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
  finally {
    currentReader = undefined
  }
}

async function refresh() {
  try {
    applyState(await callRpc<ChatDevtoolsStateResult>(chatDevtoolsGetStateRpc))
    error.value = undefined
  }
  catch (cause) {
    connected.value = false
    error.value = cause instanceof Error ? cause.message : "Open this page from Vite DevTools to connect to your local chat."
  }
}

async function send() {
  const text = input.value.trim()
  if (!text || status.value !== "ready") {
    return
  }

  input.value = ""
  status.value = "submitted"
  error.value = undefined

  try {
    const chat = selectedChat()?.name
    currentReader?.cancel()
    currentReader = undefined
    appendPendingUserMessage(text, chat)
    appendPendingAssistantMessage(chat)
    await nextTick()
    await waitForFrame()
    status.value = "streaming"

    if (await readDirectBridgeStream({ ...(chat ? { chat } : {}), text })) {
      return
    }

    const result = await callRpc<ChatDevtoolsSendResult>(chatDevtoolsSendRpc, {
      ...(chat ? { chat } : {}),
      text,
    })
    if (!result.streamId) {
      pendingUserMessage.value = undefined
      applyState(result)
      status.value = "ready"
      return
    }

    const reader = rpcClient?.streaming.subscribe<ChatDevtoolsStreamEvent>(chatDevtoolsStreamChannel, result.streamId, {
      highWaterMark: 1024,
    })
    if (!reader) {
      throw new Error("Chat DevTools streaming client is unavailable.")
    }
    currentReader = reader

    for await (const event of reader) {
      applyStreamEvent(event)
      if (event.type === "error") break
    }
  }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : "Chat DevTools send failed."
    if (connected.value) {
      clearPendingMessages()
      error.value = message
      return
    }

    clearPendingMessages()
    await runStandaloneSimulation(text)
  }
  finally {
    currentReader = undefined
    status.value = "ready"
  }
}

async function clear() {
  simulationRunId++
  try {
    currentReader?.cancel()
    currentReader = undefined
    pendingUserMessage.value = undefined
    pendingAssistantMessage.value = undefined
    applyState(await callRpc<ChatDevtoolsStateResult>(chatDevtoolsClearRpc, {
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

onMounted(refresh)
onBeforeUnmount(() => stopSidebarResize?.())
</script>

<template>
  <UApp>
    <main class="isolate flex h-dvh flex-col bg-default text-default antialiased">
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
        <section class="min-h-0 overflow-y-auto overflow-x-hidden">
          <UChatMessages
            v-if="messages.length"
            :messages="messages"
            :should-auto-scroll="status === 'streaming'"
            compact
            class="min-h-full px-3 py-2"
          >
            <template #content="{ content, message, parts }">
              <div class="flex min-w-0 flex-col gap-2 text-sm/5">
                <UChatShimmer
                  v-if="message.loading"
                  text="Thinking..."
                  :duration="1.8"
                />
                <UChatTool
                  v-for="part in parts"
                  :key="part.tool.id"
                  icon="i-lucide-terminal"
                  loading-icon="i-lucide-terminal"
                  :text="renderToolCommand(part.tool)"
                  :loading="part.tool.status === 'running'"
                  :streaming="part.tool.status === 'running'"
                  variant="card"
                  :default-open="false"
                  :ui="{
                    root: 'min-w-0 rounded-md',
                    trigger: 'min-h-7 px-2 py-1 text-xs',
                    leading: 'size-3.5',
                    leadingIcon: 'size-3.5 opacity-70',
                    label: 'min-w-0 truncate',
                    trailingIcon: 'size-3.5 opacity-70',
                    body: 'p-2 text-xs/5',
                  }"
                >
                  <Suspense
                    v-if="part.tool.output !== undefined"
                  >
                    <Comark class="space-y-1 text-toned [&_em]:text-muted [&_h3]:font-medium [&_h3]:text-highlighted [&_p]:my-0 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-elevated [&_pre]:p-2">
                      {{ renderToolOutput(part.tool) }}
                    </Comark>
                  </Suspense>
                </UChatTool>
                <Suspense
                  v-if="content"
                >
                  <Comark class="text-sm/5 text-pretty [&_code]:rounded [&_code]:bg-elevated [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-elevated [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5">
                    {{ content }}
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
                  <UTooltip
                    v-for="file in fileRows"
                    :key="file.path"
                    :text="file.path"
                  >
                    <UButton
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
                        <div class="ml-auto flex min-w-0 items-center gap-1">
                          <UBadge
                            v-if="file.kind === 'directory' && fileMaterialization(file)"
                            :color="fileMaterialization(file) === 'lazy' ? 'warning' : 'success'"
                            variant="soft"
                            size="sm"
                            class="shrink-0"
                          >
                            {{ fileMaterializationLabel(file) }}
                          </UBadge>
                          <span v-if="fileTrailing(file)" class="truncate text-xs text-muted">
                            {{ fileTrailing(file) }}
                          </span>
                        </div>
                      </template>
                    </UButton>
                  </UTooltip>
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
                        <p v-if="tool.description" class="mt-1 line-clamp-2 text-xs/5 text-muted">
                          {{ tool.description }}
                        </p>
                        <div v-if="tool.category" class="mt-2">
                          <UBadge color="neutral" variant="outline" size="sm">
                            {{ tool.category }}
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
                <div v-if="state.instructions?.length" class="space-y-2">
                  <div
                    v-for="(instruction, index) in state.instructions"
                    :key="index"
                    class="rounded-md border border-default bg-default/60 p-3"
                  >
                    <div class="mb-2 flex items-center gap-2">
                      <UIcon name="i-lucide-scroll-text" class="size-4 text-muted" />
                      <span class="text-sm font-medium">System instructions</span>
                      <UBadge color="neutral" variant="soft" size="sm" class="ml-auto">
                        {{ index + 1 }}
                      </UBadge>
                    </div>
                    <Suspense>
                      <Comark class="text-xs/5 text-toned [&_code]:rounded [&_code]:bg-elevated [&_code]:px-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-elevated [&_pre]:p-2 [&_strong]:text-highlighted [&_ul]:list-disc [&_ul]:pl-4">
                        {{ instruction }}
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

      <footer class="shrink-0 px-2 pb-2 pt-1">
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
        <UChatPrompt
          v-model="input"
          placeholder="Type a message..."
          variant="subtle"
          :rows="1"
          :maxrows="3"
          :disabled="status !== 'ready'"
          size="xs"
          :ui="{
            root: 'gap-1 px-2 py-1 rounded-md',
            body: 'min-w-0 flex-1 text-sm',
            base: '!px-0 !py-0 text-sm/5',
            footer: 'gap-1',
          }"
          @submit="send"
        >
          <UChatPromptSubmit
            :status="status"
            size="xs"
            square
            class="shrink-0"
          />
        </UChatPrompt>
      </footer>
    </main>
  </UApp>
</template>
