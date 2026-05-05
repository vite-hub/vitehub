<script setup lang="ts">
import {
  chatDevtoolsRpcClear,
  chatDevtoolsRpcGetState,
  chatDevtoolsRpcSend,
  chatDevtoolsStateKey,
  type ChatDevtoolsResult,
  type ChatDevtoolsState,
  type ChatDevtoolsTranscriptMessage,
} from "@vitehub/chat/devtools"

type SharedState<T> = {
  value: () => T
  on: (event: "updated", handler: (state: T) => void) => (() => void) | void
}

type DevtoolsRpcClient = {
  call<T>(name: string, params?: Record<string, unknown>): Promise<T>
  ensureTrusted?: () => Promise<boolean>
  sharedState: {
    get<T>(key: string): Promise<SharedState<T>>
  }
}

type ChatUiMessage = {
  id: string
  role: "user" | "assistant"
  parts: Array<{ type: "text", text: string }>
}

const rpc = shallowRef<DevtoolsRpcClient>()
const connecting = ref(true)
const pending = ref(false)
const connectionError = ref("")
const draft = ref("")
const chatName = ref("chat")
const chats = ref<string[]>([])
const messages = ref<ChatDevtoolsTranscriptMessage[]>([])
const demoReplyTimer = ref<ReturnType<typeof setInterval>>()
let unsubscribeSharedState: (() => void) | void
const transcript = useTemplateRef<HTMLElement>("transcript")
const { y: transcriptScrollTop } = useScroll(transcript, { behavior: "smooth" })

const connected = computed(() => !!rpc.value)
const previewMode = computed(() => !connecting.value && !connected.value)
const canUseComposer = computed(() => connected.value || previewMode.value)
const chatItems = computed(() => {
  const names = chats.value.length ? chats.value : [chatName.value || "chat"]
  return [...new Set(names)].map(name => ({ label: name, value: name }))
})
const hasMultipleChats = computed(() => chatItems.value.length > 1)
const chatStatus = computed<"ready" | "submitted">(() => pending.value ? "submitted" : "ready")
const streamingAssistantMessageId = computed(() => {
  if (!pending.value) return undefined
  return [...messages.value].reverse().find(message => message.author === "assistant")?.id
})
const uiMessages = computed<ChatUiMessage[]>(() => messages.value.map(message => ({
  id: message.id,
  role: message.author === "user" ? "user" : "assistant",
  parts: [{ type: "text", text: message.text }],
})))

function applyResult(result: ChatDevtoolsResult) {
  chats.value = result.chats || []
  chatName.value = result.chatName || result.chats?.[0] || chatName.value || "chat"
  messages.value = result.messages || []
  pending.value = !!result.pending
}

function createMessage(author: ChatDevtoolsTranscriptMessage["author"], text: string): ChatDevtoolsTranscriptMessage {
  const chat = chatName.value || "chat"

  return {
    author,
    chat,
    id: globalThis.crypto?.randomUUID?.() || `${author}-${Date.now()}-${messages.value.length}`,
    text,
    threadId: `preview:${chat}`,
    timestamp: new Date().toISOString(),
  }
}

function textPartText(part: unknown): string {
  if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
    return part.text
  }
  return ""
}

function stopDemoReply() {
  if (!demoReplyTimer.value) return
  clearInterval(demoReplyTimer.value)
  demoReplyTimer.value = undefined
}

function streamDemoReply(text: string) {
  stopDemoReply()
  pending.value = true

  const reply = createMessage("assistant", "")
  messages.value = [...messages.value, reply]

  const response = [
    "Preview mode: the Chat DevTools UI is working.",
    "Open it from Vite DevTools to connect to the local Nitro bridge and run real get, send, and clear actions.",
    `Your draft was: "${text}"`,
  ].join("\n\n")
  let index = 0

  demoReplyTimer.value = setInterval(() => {
    index += 3
    reply.text = response.slice(0, index)
    messages.value = [...messages.value]

    if (index >= response.length) {
      stopDemoReply()
      pending.value = false
    }
  }, 18)
}

function applySharedState(state: ChatDevtoolsState) {
  applyResult(state)
}

async function runBridge(action: (client: DevtoolsRpcClient) => Promise<ChatDevtoolsResult>, fallbackPending = true) {
  const client = rpc.value
  if (!client) {
    return
  }

  if (fallbackPending) {
    pending.value = true
  }
  try {
    applyResult(await action(client))
  }
  catch (cause) {
    pending.value = false
    throw cause
  }
}

async function refresh() {
  await runBridge(client => client.call<ChatDevtoolsResult>(chatDevtoolsRpcGetState, {
    chatName: chatName.value,
  }), false)
}

async function send() {
  if (pending.value || !canUseComposer.value) return

  const text = draft.value.trim()
  if (!text) return

  draft.value = ""
  if (!rpc.value) {
    messages.value = [...messages.value, createMessage("user", text)]
    streamDemoReply(text)
    return
  }

  await runBridge(client => client.call<ChatDevtoolsResult>(chatDevtoolsRpcSend, {
    chatName: chatName.value,
    text,
  }))
}

async function clear() {
  if (!rpc.value) {
    stopDemoReply()
    pending.value = false
    messages.value = []
    return
  }

  await runBridge(client => client.call<ChatDevtoolsResult>(chatDevtoolsRpcClear, {
    chatName: chatName.value,
  }))
}

onMounted(async () => {
  try {
    const { connectRemoteDevTools } = await import("@vitejs/devtools-kit/client")
    rpc.value = await connectRemoteDevTools() as DevtoolsRpcClient
    await rpc.value.ensureTrusted?.()
    const sharedState = await rpc.value.sharedState.get<ChatDevtoolsState>(chatDevtoolsStateKey)
    applySharedState(sharedState.value())
    unsubscribeSharedState = sharedState.on("updated", applySharedState)
    await refresh()
  }
  catch (cause) {
    connectionError.value = cause instanceof Error ? cause.message : String(cause)
  }
  finally {
    connecting.value = false
  }
})

onBeforeUnmount(() => {
  stopDemoReply()
  unsubscribeSharedState?.()
})

watch([() => messages.value.length, () => messages.value.at(-1)?.text], async () => {
  await nextTick()
  transcriptScrollTop.value = transcript.value?.scrollHeight || 0
})
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
        v-if="previewMode && connectionError"
        icon="i-lucide-info"
        title="Preview mode"
        description="Open from Vite DevTools to reach the local chat bridge. The composer below streams a local preview reply."
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
      >
        <template #content="{ message }">
          <template
            v-for="(part, index) in message.parts"
            :key="`${message.id}-${part.type}-${index}`"
          >
            <ChatComark
              v-if="message.role === 'assistant'"
              :markdown="textPartText(part)"
              :streaming="message.id === streamingAssistantMessageId"
            />
            <p
              v-else
              class="whitespace-pre-wrap"
            >
              {{ textPartText(part) }}
            </p>
          </template>
        </template>
      </UChatMessages>
    </section>

    <footer class="shrink-0 p-3">
      <UChatPrompt
        v-model="draft"
        :disabled="!canUseComposer || pending"
        placeholder="Type a message..."
        aria-label="Message"
        :rows="1"
        :maxrows="4"
        @submit="send"
      >
        <UChatPromptSubmit
          :status="chatStatus"
          :disabled="!canUseComposer || !draft.trim()"
          aria-label="Send message"
          title="Send message"
        />
      </UChatPrompt>
    </footer>
  </main>
</template>
