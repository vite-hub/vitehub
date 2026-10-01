<script setup lang="ts">
import type { AgentChatPromptSubmit, ViteHubUISession } from "@vite-hub/ui";
import type { ChatStatus, FileUIPart, UIMessage } from "ai";
import { computed, onBeforeUnmount, ref } from "vue";

// Synthetic sessions. In an application, load them from your own persistence layer.
const sessions = ref<ViteHubUISession[]>([
  {
    id: "deploy",
    title: "Production deploy failure",
    updatedAt: "2026-08-23T09:12:00.000Z",
    messages: [
      { id: "deploy-1", role: "user", parts: [{ type: "text", text: "Why did the 09:05 deploy fail?" }] },
      {
        id: "deploy-2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Read the build log before answering.", state: "done" },
          { type: "text", text: "The build ran out of memory while it generated **4,000 pages**. Raise the memory limit or split the prerender step." },
        ],
      },
    ],
  },
  {
    id: "refund",
    title: "Refund policy question",
    updatedAt: "2026-08-22T16:40:00.000Z",
    messages: [
      { id: "refund-1", role: "user", parts: [{ type: "text", text: "Can a customer get a refund after 30 days?" }] },
      { id: "refund-2", role: "assistant", parts: [{ type: "text", text: "Only for annual plans. Monthly plans end at the next renewal date." }] },
    ],
  },
  { id: "new", title: "New session", messages: [] },
]);
const selectedId = ref("deploy");
const selected = computed(() => sessions.value.find((session) => session.id === selectedId.value)!);
const input = ref("");
const files = ref<FileUIPart[]>([]);
const status = ref<ChatStatus>("ready");
let timeout: ReturnType<typeof setTimeout> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;

function setMessages(id: string, update: (messages: readonly UIMessage[]) => UIMessage[]) {
  sessions.value = sessions.value.map((session) =>
    session.id === id ? { ...session, messages: update(session.messages) } : session,
  );
}

function selectSession(id: string) {
  stop();
  selectedId.value = id;
  input.value = "";
  files.value = [];
}

// Replace this function with `sendMessage({ text, files })` from `useChat()`.
function submit({ text, files: attached }: AgentChatPromptSubmit) {
  const sessionId = selectedId.value;
  const count = selected.value.messages.length;
  setMessages(sessionId, (messages) => [
    ...messages,
    {
      id: `${sessionId}-${count}`,
      role: "user",
      parts: [...(text ? [{ type: "text" as const, text }] : []), ...attached],
    },
  ]);
  input.value = "";
  files.value = [];
  status.value = "submitted";
  const words = `I received ${attached.length} attachment(s). This block has no model, so the reply is synthetic. Replace submit() with your transport.`.split(" ");
  let index = 0;
  timeout = setTimeout(() => {
    status.value = "streaming";
    interval = setInterval(() => {
      index++;
      const done = index >= words.length;
      setMessages(sessionId, (messages) => [
        ...messages.filter((message) => message.id !== `${sessionId}-reply-${count}`),
        {
          id: `${sessionId}-reply-${count}`,
          role: "assistant",
          parts: [{ type: "text", text: words.slice(0, index).join(" "), state: done ? "done" : "streaming" }],
        },
      ]);
      if (done) stop();
    }, 50);
  }, 400);
}

function stop() {
  clearTimeout(timeout);
  clearInterval(interval);
  status.value = "ready";
}

onBeforeUnmount(stop);
</script>

<template>
  <div class="grid h-[36rem] min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-default md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-1">
    <nav aria-label="Chat sessions" class="flex min-h-0 gap-1 overflow-x-auto border-b border-default p-2 md:flex-col md:overflow-y-auto md:border-e md:border-b-0">
      <UButton
        v-for="session in sessions"
        :key="session.id"
        :label="session.title"
        :aria-current="session.id === selectedId ? 'page' : undefined"
        color="neutral"
        :variant="session.id === selectedId ? 'soft' : 'ghost'"
        class="shrink-0 justify-start"
        :ui="{ label: 'truncate' }"
        @click="selectSession(session.id)"
      />
    </nav>

    <AgentSession :session="selected" :status="status" class="min-h-0">
      <template #composer>
        <p v-if="selected.messages.length === 0" class="mb-3 text-center text-sm text-muted">
          Ask a question or attach a log file.
        </p>
        <!-- Key the prompt by session so a pending file read cannot update another session. -->
        <AgentChatPrompt
          :key="selected.id"
          v-model="input"
          v-model:files="files"
          accept="image/*,.txt,.log"
          :status="status"
          placeholder="Message the Agent…"
          @submit="submit"
          @stop="stop"
        />
      </template>
    </AgentSession>
  </div>
</template>
