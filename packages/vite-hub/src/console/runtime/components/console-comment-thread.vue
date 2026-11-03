<script setup lang="ts">
import { createCommentsClient } from "@vite-hub/comments/client";
import { type CommentCan, CommentThread, provideComments, useComments } from "@vite-hub/ui";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";

import type { CommentThread as CommentThreadModel } from "@vite-hub/comments/client";

import {
  consoleCommentsTransport,
  consoleCommentSubjectLabel,
  isConsoleCommentThread,
  readConsoleCommentSession,
} from "../client/comment-thread";
import type { ConsoleCommentSession } from "../client/comment-thread";
import type { ConsoleOperationView } from "../definitions";
import { operationLink } from "../client/operation-view";
import { useConsoleToast } from "../client/toast";
import ConsoleState from "./console-state.vue";

/**
 * One comment thread in a side panel, opened from the Comments page. It uses the comment parts of `@vite-hub/ui`, and
 * each change runs a `comments.*` operation with the Console user, so the app's `authorize` decides what is allowed.
 * The comments state it provides gives the reply box its `@` mentions.
 */
const props = defineProps<{
  definitionsBase: string;
  /** The id of the open thread. Without it the panel is closed. */
  id?: string;
  /** The thread as the list has it, so the panel opens without a request. */
  initial?: Record<string, unknown>;
  /** Derive the page link even when this thread is outside the active list filter. */
  view: ConsoleOperationView;
}>();
const emit = defineEmits<{ close: []; changed: [thread: CommentThreadModel]; removed: [id: string] }>();

const toast = useConsoleToast();
const client = createCommentsClient({ refreshOnFocus: false, transport: consoleCommentsTransport(props.definitionsBase) });
const thread = shallowRef<CommentThreadModel>();
const error = shallowRef<unknown>();
const loading = ref(false);
const session = shallowRef<ConsoleCommentSession>();
const canWrite = computed(() => session.value?.capabilities.reply === true);
// What `comments.session` allows for this thread. The parts show only these controls; the operations check again.
const can: CommentCan = (action, { message }) => {
  const capabilities = session.value?.capabilities;
  if (!capabilities) return false;
  if (action === "edit" || action === "delete") return message !== undefined && capabilities[action].includes(message.id);
  return capabilities[action];
};
const link = computed(() => thread.value ? operationLink(thread.value, props.view) : undefined);

// The panel shows one thread and needs no pins, keys, or deep links, so the state does not start. It still gives the
// reply box the people to mention, and the parts the signed-in user and what that user may do.
const comments = useComments({
  autoStart: false,
  can,
  client,
  hotkey: false,
  subject: () => thread.value?.subject ?? { id: "/", kind: "page" },
  user: () => session.value?.user,
});
provideComments(comments);

const open = computed({
  get: () => Boolean(props.id),
  set: (value: boolean) => {
    if (!value) emit("close");
  },
});
const title = computed(() => (thread.value ? `Comment ${thread.value.n}` : "Comment"));
const where = computed(() => (thread.value ? `On ${consoleCommentSubjectLabel(thread.value.subject)}` : "Loading the thread"));

// Focus lands on the thread, as in CommentPanel, not on the first header button, whose tooltip would cover the title.
const root = ref<HTMLElement | null>(null);
function focusThread(event: Event): void {
  event.preventDefault();
  void nextTick(() => root.value?.querySelector<HTMLElement>("[data-slot='comment-thread']")?.focus());
}

let controller: AbortController | undefined;
async function load(): Promise<void> {
  controller?.abort();
  const id = props.id;
  if (!id) return;
  const current = new AbortController();
  controller = current;
  error.value = undefined;
  loading.value = true;
  try {
    const listed = isConsoleCommentThread(props.initial) && props.initial.id === id ? props.initial : undefined;
    const found = listed ?? (await client.get({ id }));
    if (current.signal.aborted) return;
    if (!found) throw new Error("This thread was deleted, or you may not read it.");
    thread.value = found;
    const currentSession = await readConsoleCommentSession(props.definitionsBase, found.subject, current.signal, found.id);
    if (current.signal.aborted) return;
    session.value = currentSession;
  } catch (cause) {
    if (current.signal.aborted) return;
    error.value = cause;
  } finally {
    if (controller === current) loading.value = false;
  }
}

watch(
  () => props.id,
  () => {
    thread.value = undefined;
    session.value = undefined;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());

async function update(next: CommentThreadModel): Promise<void> {
  if (props.id !== next.id) return;
  thread.value = next;
  emit("changed", next);
  session.value = undefined;
  const current = controller;
  try {
    const currentSession = await readConsoleCommentSession(props.definitionsBase, next.subject, current?.signal, next.id);
    if (props.id === next.id && !current?.signal.aborted) session.value = currentSession;
  } catch (cause) {
    // The mutation succeeded. A failed capability refresh must not leave a reply looking unsent.
    if (props.id === next.id && !current?.signal.aborted) error.value = cause;
  }
}

function gone(id: string): void {
  toast.show({ title: "Comment deleted" });
  emit("removed", id);
  emit("close");
}

// CommentThread shows a failure of these handlers next to the reply box. Deleting the first message deletes the thread,
// and the part asks first.
async function reply(body: string, mentions: string[]): Promise<void> {
  if (thread.value) await update(await comments.reply(thread.value.id, body, mentions));
}
async function edit(messageId: string, body: string, mentions: string[]): Promise<void> {
  if (thread.value) await update(await comments.edit(thread.value.id, messageId, body, mentions));
}
async function remove(messageId: string): Promise<void> {
  const id = thread.value?.id;
  if (!id) return;
  const next = await comments.remove(id, messageId);
  if (next) await update(next);
  else gone(id);
}
async function resolve(): Promise<void> {
  if (thread.value) await update(await comments.resolve(thread.value.id));
}
async function reopen(): Promise<void> {
  if (thread.value) await update(await comments.reopen(thread.value.id));
}
</script>

<template>
  <USlideover v-model:open="open" :title="title" :description="where" :content="{ onOpenAutoFocus: focusThread }" :ui="{ content: 'max-w-lg' }">
    <template #content>
      <div ref="root" class="console-comment-thread flex h-full min-h-0 flex-col">
        <div v-if="error || !thread" class="flex items-center justify-between gap-2 border-b border-default py-1.5 ps-3 pe-2">
          <span class="font-semibold text-highlighted">{{ title }}</span>
          <UButton aria-label="Close" color="neutral" icon="i-lucide-x" size="xs" variant="ghost" @click="emit('close')" />
        </div>
        <ConsoleState v-if="error" :error="error" title="Couldn't load the thread" :retry="load" />
        <p v-else-if="!thread" role="status" class="p-4 text-sm text-muted">Loading the thread…</p>
        <CommentThread
          v-else
          :attachments="false"
          :dismissible="false"
          :read-only="loading"
          :thread="thread"
          :on-reply="reply"
          :on-edit="edit"
          :on-delete="remove"
          :on-resolve="resolve"
          :on-reopen="reopen"
          @close="emit('close')"
        >
          <template #actions>
            <UTooltip v-if="link" text="Open page">
              <UButton aria-label="Open page" color="neutral" icon="i-lucide-external-link" size="xs" variant="ghost" :href="link" external target="_blank" rel="noreferrer" />
            </UTooltip>
          </template>
          <template #anchor="{ thread: current }">
            <p class="mx-3 mt-3 text-xs text-muted">
              On <span class="font-mono text-highlighted">{{ consoleCommentSubjectLabel(current.subject) }}</span>
            </p>
            <blockquote v-if="current.anchor.kind === 'text'" data-slot="comment-thread-quote">{{ current.anchor.exact }}</blockquote>
          </template>
        </CommentThread>
        <p v-if="thread && !loading && !canWrite" class="border-t border-default px-3 py-2 text-xs text-muted">
          You can read this thread. The app's <code>authorize</code> policy does not let you reply to it.
        </p>
      </div>
    </template>
  </USlideover>
</template>

<style scoped>
/* The thread fills the panel, its messages scroll, and the reply box stays at the bottom. */
.console-comment-thread :deep([data-slot="comment-thread"]) {
  flex: 1;
  min-height: 0;
}

.console-comment-thread :deep([data-slot="comment-thread-messages"]) {
  flex: 1;
  max-height: none;
}

/* The reply box sits at the bottom of the panel, so its mention menu opens upward. */
.console-comment-thread :deep([data-slot="comment-composer-mentions"]) {
  bottom: 100%;
  margin: 0 0 0.25rem;
  top: auto;
}
</style>
