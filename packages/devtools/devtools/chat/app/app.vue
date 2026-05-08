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

const simulationDelayMs = 280

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

function renderToolValue(value: unknown) {
  if (value == null) {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  try {
    return JSON.stringify(value, null, 2)
  }
  catch {
    return String(value)
  }
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
  const now = Date.now()
  const assistant: ChatMessage = {
    content: "Thinking...",
    id: `assistant-${now}`,
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
        query: text,
        source: "data-sources",
      },
      name: "workspace.search",
      status: "running",
      text: "workspace.search",
      updatedAt: new Date().toISOString(),
    },
    {
      id: `tool-${now}-read-file`,
      input: {
        path: "server/workspaces/data-sources/AGENTS.md",
      },
      name: "workspace.readFile",
      status: "running",
      text: "workspace.readFile",
      updatedAt: new Date().toISOString(),
    },
  ]

  await wait(simulationDelayMs)
  assistant.parts = [{ type: "tool", tool: tools[0]! }]
  appendOrUpdateMessage({ ...assistant, parts: [...assistant.parts] })

  await wait(simulationDelayMs)
  tools[0] = {
    ...tools[0]!,
    output: {
      matches: [
        "Repository inventory and workspace guidance",
        "Forecasting and portal data source notes",
      ],
    },
    status: "completed",
    updatedAt: new Date().toISOString(),
  }
  assistant.parts = [{ type: "tool", tool: tools[0]! }]
  appendOrUpdateMessage({ ...assistant, parts: [...assistant.parts] })

  await wait(simulationDelayMs)
  assistant.parts = [
    { type: "tool", tool: tools[0]! },
    { type: "tool", tool: tools[1]! },
  ]
  appendOrUpdateMessage({ ...assistant, parts: [...assistant.parts] })

  await wait(simulationDelayMs)
  tools[1] = {
    ...tools[1]!,
    output: {
      bytes: 1482,
      summary: "Loaded Quiver Chat workspace instructions and source boundaries.",
    },
    status: "completed",
    updatedAt: new Date().toISOString(),
  }
  assistant.parts = [
    { type: "tool", tool: tools[0]! },
    { type: "tool", tool: tools[1]! },
  ]
  assistant.content = ""
  appendOrUpdateMessage({ ...assistant, parts: [...assistant.parts] })

  const chunks = [
    "I found the relevant workspace notes and traced the request through the Quiver Chat data sources. ",
    "The likely next step is to answer from the repository context first, then cite which workspace files or source records were used. ",
    "In a connected Vite DevTools session this same panel will show live Chat SDK tool calls as they move from running to completed.",
  ]
  for (const chunk of chunks) {
    await wait(simulationDelayMs)
    assistant.content += chunk
    appendOrUpdateMessage({ ...assistant, parts: [...assistant.parts] })
  }

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
    messages.value = []
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
          :status="status"
          :should-auto-scroll="status === 'streaming'"
          class="min-h-full px-4 py-3"
        >
          <template #content="{ content, parts }">
            <div class="flex flex-col gap-2">
              <p
                v-if="content"
                class="whitespace-pre-wrap"
              >
                {{ content }}
              </p>
              <UChatTool
                v-for="part in parts"
                :key="part.tool.id"
                :text="part.tool.text || part.tool.name"
                :suffix="part.tool.status"
                :loading="part.tool.status === 'running'"
                :streaming="part.tool.status === 'running'"
                variant="card"
                :default-open="part.tool.status !== 'completed'"
              >
                <div class="space-y-2">
                  <div
                    v-if="part.tool.input !== undefined"
                    class="space-y-1"
                  >
                    <div class="text-xs font-medium text-muted">
                      Input
                    </div>
                    <pre class="overflow-x-auto text-xs">{{ renderToolValue(part.tool.input) }}</pre>
                  </div>
                  <div
                    v-if="part.tool.output !== undefined"
                    class="space-y-1"
                  >
                    <div class="text-xs font-medium text-muted">
                      Output
                    </div>
                    <pre class="overflow-x-auto text-xs">{{ renderToolValue(part.tool.output) }}</pre>
                  </div>
                </div>
              </UChatTool>
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
