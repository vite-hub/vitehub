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
      {
        id: "deploy-1",
        role: "user",
        parts: [{ type: "text", text: "Why did the 09:05 deploy fail?" }],
      },
      {
        id: "deploy-2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Read the build log before answering.", state: "done" },
          {
            type: "text",
            text: "The build ran out of memory while it generated **4,000 pages**. Raise the memory limit or split the prerender step.",
          },
        ],
      },
    ],
  },
  {
    id: "release",
    title: "Release readiness",
    updatedAt: "2026-08-22T16:40:00.000Z",
    messages: [
      {
        id: "release-1",
        role: "user",
        parts: [{ type: "text", text: "Is the release ready to ship?" }],
      },
      {
        id: "release-2",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "The build and focused tests pass. The preview still needs a check at mobile widths before you publish.",
          },
        ],
      },
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
let nextMessageId = 0;

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
  if (status.value !== "ready") return;
  const messageId = ++nextMessageId;
  setMessages(sessionId, (messages) => [
    ...messages,
    {
      id: `${sessionId}-user-${messageId}`,
      role: "user",
      parts: [...(text ? [{ type: "text" as const, text }] : []), ...attached],
    },
  ]);
  input.value = "";
  files.value = [];
  status.value = "submitted";
  const reply = attached.length
    ? "I would check the failure near the end of the log first, then compare the memory limit with the previous successful build. Keep the failed job output with the session so the next run has the same context."
    : sessionId === "release"
      ? "Check the preview at 390px and 1280px, then confirm the package exports resolve in a fresh application. Keep the release on hold if either check fails."
      : "Start by rerunning the failed build with the same commit and a higher memory limit. If it passes, split prerendering into smaller batches and keep the original log for comparison.";
  const words = reply.split(" ");
  let index = 0;
  timeout = setTimeout(() => {
    status.value = "streaming";
    interval = setInterval(() => {
      index++;
      const done = index >= words.length;
      setMessages(sessionId, (messages) => [
        ...messages.filter((message) => message.id !== `${sessionId}-reply-${messageId}`),
        {
          id: `${sessionId}-reply-${messageId}`,
          role: "assistant",
          parts: [
            {
              type: "text",
              text: words.slice(0, index).join(" "),
              state: done ? "done" : "streaming",
            },
          ],
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
  <div class="@container h-[36rem] min-w-0 bg-default">
    <div
      class="grid h-full grid-rows-[auto_minmax(0,1fr)] @2xl:grid-cols-[14rem_minmax(0,1fr)] @2xl:grid-rows-1"
    >
      <nav
        aria-label="Chat sessions"
        class="flex min-h-0 gap-1 overflow-x-auto border-b border-default p-2 @2xl:flex-col @2xl:overflow-y-auto @2xl:border-e @2xl:border-b-0"
      >
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
  </div>
</template>
