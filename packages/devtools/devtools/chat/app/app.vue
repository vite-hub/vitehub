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
} from "../../../../chat/src/devtools-shared"

type ChatStatus = "ready" | "submitted" | "streaming" | "error"

const input = ref("")
const status = ref<ChatStatus>("ready")
const error = ref<string | undefined>()
const connected = ref(false)
const pendingUserMessageId = ref<string | undefined>()
const state = ref<ChatDevtoolsStateResult>({
  chats: [],
  selected: "",
})
let rpcClient: Awaited<ReturnType<typeof getDevToolsRpcClient>> | undefined
let currentReader: { cancel: () => unknown } | undefined

const messages = computed(() => {
  const selected = state.value.chats.find(chat => chat.name === state.value.selected) || state.value.chats[0]
  return (selected?.messages || []).map(message => ({
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    parts: [{ type: "text", text: renderMessageText(message) }],
  }))
})

function selectedChat() {
  return state.value.chats.find(chat => chat.name === state.value.selected) || state.value.chats[0]
}

function isSendPending() {
  const chatMessages = selectedChat()?.messages || []
  const userIndex = pendingUserMessageId.value
    ? chatMessages.findIndex(message => message.id === pendingUserMessageId.value)
    : chatMessages.findLastIndex(message => message.role === "user")
  if (userIndex < 0) return false

  const assistant = chatMessages.slice(userIndex + 1).findLast(message => message.role === "assistant")
  if (!assistant) return true
  const hasRunningTool = assistant.tools?.some(tool => tool.status === "running")
  return hasRunningTool || (!assistant.text.trim() && !assistant.tools?.length)
}

function applyStreamEvent(event: ChatDevtoolsStreamEvent) {
  if (event.type === "state") {
    state.value = event.state
    return
  }
  if (event.type === "error") {
    error.value = event.message
  }
}

function renderToolOutput(output: unknown) {
  if (output == null) {
    return ""
  }
  return typeof output === "string" ? output : JSON.stringify(output)
}

function renderMessageText(message: ChatDevtoolsMessage) {
  const tools = message.tools || []
  if (!tools.length) {
    return message.text
  }

  const toolText = tools
    .map((tool) => {
      const output = renderToolOutput(tool.output)
      return output
        ? `- ${tool.status}: ${tool.text} -> ${output}`
        : `- ${tool.status}: ${tool.text}`
    })
    .join("\n")

  return [message.text, `Tools:\n${toolText}`].filter(Boolean).join("\n\n")
}

function appendDummy(message: ChatDevtoolsMessage) {
  const chat = state.value.chats[0] ||= { name: "dev", messages: [] }
  chat.messages.push(message)
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
    state.value = await callRpc<ChatDevtoolsStateResult>(chatDevtoolsGetStateRpc)
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

    const result = await callRpc<ChatDevtoolsSendResult>(chatDevtoolsSendRpc, {
      ...(chat ? { chat } : {}),
      text,
    })
    state.value = result
    pendingUserMessageId.value = selectedChat()?.messages.findLast(message => message.role === "user")?.id
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
    status.value = isSendPending() ? "submitted" : "ready"
  }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : "Chat DevTools send failed."
    if (connected.value) {
      error.value = message
      return
    }

    appendDummy({
      id: `user-${Date.now()}`,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    })
    appendDummy({
      id: `assistant-${Date.now()}`,
      role: "assistant",
      text: `Dummy reply: ${text}`,
      createdAt: new Date().toISOString(),
    })
    error.value = "Running without Vite DevTools RPC. Dummy replies are local only."
  }
  finally {
    pendingUserMessageId.value = undefined
    currentReader = undefined
    status.value = "ready"
  }
}

async function clear() {
  try {
    currentReader?.cancel()
    currentReader = undefined
    state.value = await callRpc<ChatDevtoolsStateResult>(chatDevtoolsClearRpc, {
      chat: state.value.selected,
    })
    error.value = undefined
  }
  catch {
    state.value = {
      chats: [{ name: state.value.selected || "dev", messages: [] }],
      selected: state.value.selected || "dev",
    }
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

      <section class="min-h-0 flex-1 overflow-hidden">
        <UChatMessages
          v-if="messages.length"
          :messages="messages"
          class="h-full px-4 py-3"
        />
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
