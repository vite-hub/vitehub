<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef } from "vue"

const chatDevtoolsClearRpc = "@vitehub/agent/chat:clear"
const chatDevtoolsGetStateRpc = "@vitehub/agent/chat:get-state"
const chatDevtoolsSendRpc = "@vitehub/agent/chat:send"

type ChatDevtoolsMessage = {
  createdAt: string
  id: string
  loading?: boolean
  role: "user" | "assistant"
  text: string
}

type ChatDevtoolsStateResult = {
  chats: Array<{
    messages: ChatDevtoolsMessage[]
    name: string
  }>
  selected: string
}

type DevtoolsRpcClient = {
  call<T>(name: string, params?: Record<string, unknown>): Promise<T>
}

type ChatUiMessage = {
  id: string
  role: "user" | "assistant"
  parts: Array<{ type: "text", text: string }>
}

const rpc = shallowRef<DevtoolsRpcClient>()
const connecting = ref(true)
const pending = ref(false)
const status = ref("Connecting")
const connectionHint = ref("")
const draft = ref("")
const chatName = ref("chat")
const chats = ref<string[]>([])
const messages = ref<ChatDevtoolsMessage[]>([])
const queuedDemoText = ref("")
const transcript = useTemplateRef<HTMLElement>("transcript")
const demoReplyTimeout = ref<ReturnType<typeof setTimeout>>()

const connected = computed(() => !!rpc.value)
const canUseComposer = computed(() => connected.value || !!connectionHint.value)
const chatItems = computed(() => {
  const names = chats.value.length ? chats.value : [chatName.value || "chat"]
  return [...new Set(names)].map(name => ({ label: name, value: name }))
})
const hasMultipleChats = computed(() => chatItems.value.length > 1)
const chatStatus = computed<"ready" | "submitted">(() => pending.value ? "submitted" : "ready")
const uiMessages = computed<ChatUiMessage[]>(() => messages.value.map(message => ({
  id: message.id,
  role: message.role === "assistant" ? "assistant" : "user",
  parts: [{ type: "text", text: message.text }],
})))

function scrollTranscript() {
  void nextTick(() => {
    transcript.value?.scrollTo({ top: transcript.value.scrollHeight })
  })
}

function applyResult(result: ChatDevtoolsStateResult) {
  status.value = "Ready"
  chats.value = result.chats.map(chat => chat.name)
  chatName.value = chats.value.includes(chatName.value)
    ? chatName.value
    : result.selected || result.chats[0]?.name || chatName.value || "chat"
  messages.value = result.chats.find(chat => chat.name === chatName.value)?.messages || []
  scrollTranscript()
}

function createMessage(role: ChatDevtoolsMessage["role"], text: string): ChatDevtoolsMessage {
  return {
    id: globalThis.crypto?.randomUUID?.() || `${role}-${Date.now()}-${messages.value.length}`,
    role,
    text,
    createdAt: new Date().toISOString(),
  }
}

function stopDemoReply() {
  if (demoReplyTimeout.value) {
    clearTimeout(demoReplyTimeout.value)
    demoReplyTimeout.value = undefined
  }
}

function startDemoReply() {
  stopDemoReply()
  demoReplyTimeout.value = setTimeout(() => {
    const text = queuedDemoText.value
    messages.value = [
      ...messages.value,
      createMessage("assistant", `Dummy reply from ${chatName.value || "chat"}: ${text}`),
    ]
    pending.value = false
    status.value = "Demo mode"
    scrollTranscript()
  }, 400)
}

function sendDemoMessage(text: string) {
  queuedDemoText.value = text
  status.value = "Demo reply pending"
  chats.value = [chatName.value || "chat"]
  messages.value = [
    ...messages.value,
    createMessage("user", text),
  ]
  scrollTranscript()
  startDemoReply()
}

async function refresh() {
  if (!rpc.value) {
    chats.value = [chatName.value || "chat"]
    return
  }

  pending.value = true
  try {
    applyResult(await rpc.value.call<ChatDevtoolsStateResult>(chatDevtoolsGetStateRpc))
  }
  finally {
    pending.value = false
  }
}

async function send() {
  if (pending.value || !canUseComposer.value) return

  const text = draft.value.trim()
  if (!text) return

  draft.value = ""
  if (!rpc.value) {
    pending.value = true
    sendDemoMessage(text)
    return
  }

  pending.value = true
  try {
    applyResult(await rpc.value.call<ChatDevtoolsStateResult>(chatDevtoolsSendRpc, {
      chat: chatName.value,
      text,
    }))
  }
  finally {
    pending.value = false
  }
}

async function clear() {
  if (!rpc.value) {
    stopDemoReply()
    messages.value = []
    queuedDemoText.value = ""
    pending.value = false
    status.value = connectionHint.value ? "Demo mode" : status.value
    return
  }

  pending.value = true
  try {
    applyResult(await rpc.value.call<ChatDevtoolsStateResult>(chatDevtoolsClearRpc, {
      chat: chatName.value,
    }))
  }
  finally {
    pending.value = false
  }
}

onMounted(async () => {
  try {
    const { connectRemoteDevTools } = await import("@vitejs/devtools-kit/client")
    rpc.value = await connectRemoteDevTools() as DevtoolsRpcClient
    await refresh()
  }
  catch (cause) {
    connectionHint.value = cause instanceof Error ? cause.message : String(cause)
    status.value = "Demo mode"
    chats.value = [chatName.value]
  }
  finally {
    connecting.value = false
  }
})

onBeforeUnmount(stopDemoReply)
</script>

<template>
  <main
    class="fixed inset-0 flex h-dvh max-h-dvh w-dvw max-w-dvw flex-col overflow-hidden bg-default text-default"
  >
    <header class="flex h-[50px] shrink-0 items-center justify-between border-b border-default px-3">
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">
          ViteHub Chat
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <USelect
          v-if="hasMultipleChats"
          v-model="chatName"
          :items="chatItems"
          :disabled="!connected || pending || chatItems.length <= 1"
          aria-label="Chat"
          size="xs"
          class="w-32"
          @update:model-value="refresh"
        />
        <UTooltip text="Clear chat">
          <UButton
            icon="i-lucide-trash-2"
            label="Clear"
            color="neutral"
            variant="outline"
            size="xs"
            :disabled="!canUseComposer || pending || messages.length === 0"
            aria-label="Clear chat"
            title="Clear chat"
            @click="clear"
          />
        </UTooltip>
      </div>
    </header>

    <section
      ref="transcript"
      class="min-h-0 w-full max-w-full flex-1 overflow-y-auto overflow-x-hidden px-3 py-4"
    >
      <UEmpty
        v-if="connecting"
        icon="i-lucide-loader-circle"
        title="Connecting to Vite DevTools..."
        variant="naked"
        class="h-full justify-center"
      />

      <UAlert
        v-if="connectionHint"
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        description="Open from Vite DevTools to reach the local chat bridge. Direct access uses dummy replies."
        class="mb-3"
      />

      <UEmpty
        v-if="!connecting && messages.length === 0"
        title="No messages yet."
        variant="naked"
        class="h-full justify-center"
      />

      <UChatMessages
        v-else-if="messages.length > 0"
        :messages="uiMessages"
        :status="chatStatus"
        compact
        :user="{ side: 'right', variant: 'soft' }"
        :assistant="{ side: 'left', variant: 'naked' }"
      />
    </section>

    <footer class="shrink-0 p-3">
      <UChatPrompt
        v-model="draft"
        :disabled="!canUseComposer || pending"
        placeholder="Type a message..."
        aria-label="Message"
        :rows="1"
        size="sm"
        :maxrows="4"
        variant="outline"
        @submit="send"
      >
        <UChatPromptSubmit
          :status="chatStatus"
          size="sm"
          :disabled="!canUseComposer || !draft.trim()"
          aria-label="Send message"
          title="Send message"
        />
      </UChatPrompt>
    </footer>
  </main>
</template>
