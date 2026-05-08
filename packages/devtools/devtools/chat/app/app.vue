<script setup lang="ts">
import { connectRemoteDevTools, getDevToolsRpcClient } from "@vitejs/devtools-kit/client"

import {
  chatDevtoolsClearRpc,
  chatDevtoolsGetStateRpc,
  chatDevtoolsSendRpc,
  chatDevtoolsStreamChannel,
  type ChatDevtoolsMessage,
  type ChatDevtoolsSendResult,
  type ChatDevtoolsStateResult,
  type ChatDevtoolsStreamEvent,
  type ChatDevtoolsTool,
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
  selected: "",
})
const messages = ref<ChatMessage[]>([])
const pendingUserMessage = ref<ChatMessage | undefined>()
let rpcClient: Awaited<ReturnType<typeof getDevToolsRpcClient>> | undefined
let currentReader: { cancel: () => unknown } | undefined
let simulationRunId = 0

const simulationDelayMs = 360

function selectedChat(next = state.value) {
  return next.chats.find(chat => chat.name === next.selected) || next.chats[0]
}

function applyState(next: ChatDevtoolsStateResult) {
  state.value = next
  const chat = selectedChat(next)
  const nextMessages = (chat?.messages || []).map(toChatMessage)
  const pending = pendingUserMessage.value

  if (pending && pending.chat === chat?.name && !nextMessages.some(message => message.id === pending.id)) {
    messages.value = [...nextMessages, pending]
    return
  }

  pendingUserMessage.value = undefined
  messages.value = nextMessages
}

function applyStreamEvent(event: ChatDevtoolsStreamEvent) {
  if (event.type === "state") {
    applyState(event.state)
    return
  }
  if (event.type === "error") {
    error.value = event.message
  }
}

function toChatMessage(message: ChatDevtoolsMessage): ChatMessage {
  return {
    content: message.text || undefined,
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    parts: (message.tools || []).map(tool => ({ type: "tool", tool })),
  }
}

function renderToolCommand(tool: ChatDevtoolsTool) {
  const input = tool.input && typeof tool.input === "object" ? tool.input as Record<string, unknown> : {}
  if (typeof input.command === "string") {
    return input.command
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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;")
}

function renderToolOutputHtml(tool: ChatDevtoolsTool) {
  return renderToolOutput(tool)
    .split("\n")
    .map((line) => {
      if (line.startsWith("### ")) {
        return `<h4>${escapeHtml(line.slice(4))}</h4>`
      }
      if (line.startsWith("- ")) {
        return `<p>&bull; ${escapeHtml(line.slice(2))}</p>`
      }
      if (line.startsWith("_") && line.endsWith("_")) {
        return `<p><em>${escapeHtml(line.slice(1, -1))}</em></p>`
      }
      return line ? `<p>${escapeHtml(line)}</p>` : ""
    })
    .join("")
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

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runStandaloneSimulation(text: string) {
  const runId = ++simulationRunId
  const isCurrentRun = () => runId === simulationRunId
  const now = Date.now()
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
  error.value = "Running without Vite DevTools RPC. Simulating Chat SDK streaming and tool calls locally."
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

    if (!connected.value) {
      const pendingId = pendingUserMessage.value?.id
      pendingUserMessage.value = undefined
      messages.value = pendingId ? messages.value.filter(message => message.id !== pendingId) : messages.value
      await runStandaloneSimulation(text)
      return
    }

    const result = await callRpc<ChatDevtoolsSendResult>(chatDevtoolsSendRpc, {
      ...(chat ? { chat } : {}),
      text,
    })
    pendingUserMessage.value = undefined
    applyState(result)
    if (!result.streamId) {
      status.value = "ready"
      return
    }

    status.value = "streaming"

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
      const pendingId = pendingUserMessage.value?.id
      pendingUserMessage.value = undefined
      messages.value = pendingId ? messages.value.filter(message => message.id !== pendingId) : messages.value
      error.value = message
      return
    }

    const pendingId = pendingUserMessage.value?.id
    pendingUserMessage.value = undefined
    messages.value = pendingId ? messages.value.filter(message => message.id !== pendingId) : messages.value
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
    applyState(await callRpc<ChatDevtoolsStateResult>(chatDevtoolsClearRpc, {
      chat: state.value.selected,
    }))
    pendingUserMessage.value = undefined
    error.value = undefined
  }
  catch {
    state.value = {
      chats: [{ name: state.value.selected || "dev", messages: [] }],
      selected: state.value.selected || "dev",
    }
    pendingUserMessage.value = undefined
    messages.value = []
    error.value = undefined
    status.value = "ready"
  }
}

onMounted(refresh)
</script>

<template>
  <UApp>
    <main class="flex h-screen flex-col bg-default text-default">
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

      <section class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <UChatMessages
          v-if="messages.length"
          :messages="messages"
          :should-auto-scroll="status === 'streaming'"
          class="min-h-full px-4 py-3"
        >
          <template #content="{ content, message, parts }">
            <div class="flex flex-col gap-2">
              <UChatShimmer
                v-if="message.loading"
                text="Thinking..."
                :duration="1.8"
              />
              <UChatTool
                v-for="part in parts"
                :key="part.tool.id"
                :text="renderToolCommand(part.tool)"
                :loading="part.tool.status === 'running'"
                :streaming="part.tool.status === 'running'"
                variant="card"
                :default-open="false"
              >
                <div
                  v-if="part.tool.output !== undefined"
                  class="space-y-1 text-sm text-toned [&_em]:text-muted [&_h4]:font-medium [&_h4]:text-highlighted [&_p]:my-0"
                  v-html="renderToolOutputHtml(part.tool)"
                />
              </UChatTool>
              <p
                v-if="content"
                class="whitespace-pre-wrap"
              >
                {{ content }}
              </p>
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

      <footer class="shrink-0 px-4 pb-4 pt-2">
        <UAlert
          v-if="error && !connected"
          color="neutral"
          variant="soft"
          icon="i-lucide-info"
          :title="error"
          class="mb-2"
        />
        <UChatPrompt
          v-model="input"
          placeholder="Type a message..."
          variant="subtle"
          :rows="1"
          :maxrows="4"
          :disabled="status !== 'ready'"
          @submit="send"
        >
          <UChatPromptSubmit :status="status" />
        </UChatPrompt>
      </footer>
    </main>
  </UApp>
</template>
