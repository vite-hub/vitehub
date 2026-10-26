<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import { ChatSession, PromptInput, type PromptInputSubmit } from "@vite-hub/ui";
import { DefaultChatTransport } from "ai";
import type { Thread } from "../../shared/chat";

const props = defineProps<{ thread: Thread; blocked: boolean }>();
const emit = defineEmits<{ saved: []; busy: [value: boolean] }>();
const input = ref("");
const revision = ref(props.thread.revision);
const title = ref(props.thread.title);
const notice = ref("");
const recovering = ref(false);
const limitReached = computed(() => revision.value >= 20);

const { messages, status, error, sendMessage, stop, clearError } = useChat({
  id: props.thread.id,
  messages: props.thread.messages,
  transport: new DefaultChatTransport({
    api: "/api/chat",
    prepareSendMessagesRequest({ id, messages }) {
      const last = messages.at(-1);
      const text = last?.parts.filter(part => part.type === "text").map(part => part.text).join("") || "";
      return { body: { id, text, revision: revision.value } };
    },
  }),
  async onFinish({ isAbort, isError }) {
    if (!isAbort && !isError) await reload();
  },
});

const busy = computed(() => recovering.value || status.value === "submitted" || status.value === "streaming");
watch(busy, value => emit("busy", value), { immediate: true });
onBeforeUnmount(() => { void stop(); });

async function reload() {
  recovering.value = true;
  try {
    const saved = await $fetch<Thread>(`/api/chats/${props.thread.id}`);
    messages.value = saved.messages;
    revision.value = saved.revision;
    title.value = saved.title;
    clearError();
    notice.value = "Saved history loaded.";
    emit("saved");
  } catch {
    notice.value = "Could not load saved history. Sign in again or retry.";
  } finally {
    recovering.value = false;
  }
}

async function submit({ text }: PromptInputSubmit) {
  if (busy.value || props.blocked || limitReached.value) return;
  if (text.length > 2000) { notice.value = "Use at most 2,000 characters."; return; }
  notice.value = "";
  input.value = "";
  await sendMessage({ text });
  if (error.value && !input.value) input.value = text;
}

async function stopReply() {
  await stop();
  notice.value = "Stopped. Reload saved history before continuing. Partial replies are not saved.";
}
</script>

<template>
  <ChatSession :session="{ id: thread.id, title, messages }" :status
    class="h-full min-h-0" style="--vh-chat-content-padding: 1rem">
    <template #footer>
      <div class="px-4 pb-4">
        <p v-if="limitReached" role="status" class="mb-2 text-sm text-muted">
          This chat has 20 turns. Select New chat to continue.
        </p>
        <p v-else-if="error" role="alert" class="mb-2 text-sm text-error">
          The reply failed. Reload saved history, then send your draft again.
        </p>
        <p v-if="notice" role="status" class="mb-2 text-sm text-muted">{{ notice }}</p>
        <UButton v-if="error || notice" variant="link" :disabled="busy" @click="reload">
          Reload saved history
        </UButton>
        <fieldset :disabled="blocked || recovering || limitReached">
          <PromptInput v-model="input" :status :attachments="false"
            placeholder="Ask a question" @submit="submit" @stop="stopReply" @reload="reload" />
        </fieldset>
      </div>
    </template>
  </ChatSession>
</template>
