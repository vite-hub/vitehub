<script setup lang="ts">
import { inlineChannelArchiveMedia } from "@vite-hub/internal/channel-archive";
import { ChatMessage } from "@vite-hub/ui";
import type { UIMessage } from "ai";
import type { LocationQueryValue } from "vue-router";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { requestConsole } from "../client/request";
import { rememberConsoleSection } from "../sections";
import ConsoleFrame from "./console-frame.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleStatus from "./console-status.vue";
import { isSafeExternalUrl } from "./invocation/internal/url";

interface Retention {
  durable: boolean;
  maxMessages: number;
  mode: "durable-transcripts" | "provider-window";
  warning?: string;
}

interface ChannelRow {
  agent: string;
  channel: string;
  conversations: boolean;
  provider: string;
  retention: Retention;
}

interface ThreadRow {
  invocationCount: number;
  lastMessageAt?: string;
  participants: string[];
  thread: string;
  title?: string;
}

interface AttachmentRow {
  mimeType?: string;
  name?: string;
  type?: string;
  url?: string;
}

interface MessageRow {
  attachments: AttachmentRow[];
  at?: string;
  author: { isBot?: boolean; name?: string };
  id: string;
  invocationId?: string;
  role: "assistant" | "system" | "user";
  source: "invocation" | "provider" | "transcript";
  text: string;
}

const props = defineProps<{
  agentsBase: string;
  channelsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();

const route = useRoute();
const router = useRouter();
const channels = ref<ChannelRow[]>([]);
const threads = ref<ThreadRow[]>([]);
const threadsCursor = ref<string>();
const messages = ref<MessageRow[]>([]);
const messagesCursor = ref<string>();
const retention = ref<Retention>();
const channelsLoading = ref(true);
const threadsLoading = ref(false);
const messagesLoading = ref(false);
const downloading = ref<"json" | "markdown">();
const error = ref<unknown>();
let channelsRequest: AbortController | undefined;
let threadsRequest: AbortController | undefined;
let messagesRequest: AbortController | undefined;

function text(value: unknown): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  return typeof value === "string" && value ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function queryString(value: LocationQueryValue | LocationQueryValue[]): string | undefined {
  return value === null || Array.isArray(value) ? undefined : value;
}

function parseRetention(value: unknown): Retention {
  const source = record(value);
  return {
    durable: source.durable === true,
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    maxMessages: typeof source.maxMessages === "number" ? source.maxMessages : 100,
    mode: source.mode === "durable-transcripts" ? "durable-transcripts" : "provider-window",
    ...(text(source.warning) ? { warning: text(source.warning)! } : {}),
  };
}

const selectedAgent = computed(() => queryString(route.query.agent));
const selectedChannel = computed(() => queryString(route.query.channel));
const selectedThread = computed(() => queryString(route.query.thread));
const selected = computed(() => channels.value.find(entry => entry.agent === selectedAgent.value && entry.channel === selectedChannel.value));

function isAbort(failure: unknown): boolean {
  return failure instanceof Object && "name" in failure && failure.name === "AbortError";
}

function errorMessage(failure: unknown): string | undefined {
  return failure instanceof Error ? failure.message : failure ? "The Console could not load these Channels." : undefined;
}

async function loadChannels(): Promise<void> {
  channelsRequest?.abort();
  const controller = new AbortController();
  channelsRequest = controller;
  channelsLoading.value = true;
  try {
    const value = record(await requestConsole(props.channelsBase, { signal: controller.signal }));
    channels.value = list(value.channels).map(entry => ({
      agent: text(entry.agent) ?? "",
      channel: text(entry.channel) ?? "",
      conversations: entry.conversations === true,
      provider: text(entry.provider) ?? "",
      retention: parseRetention(entry.retention),
    }));
    error.value = undefined;
  } catch (failure) {
    if (!isAbort(failure)) error.value = failure;
  } finally {
    if (channelsRequest === controller) channelsLoading.value = false;
  }
}

async function loadThreads(append = false): Promise<void> {
  threadsRequest?.abort();
  const entry = selected.value;
  if (!entry?.conversations) {
    threads.value = [];
    threadsCursor.value = undefined;
    return;
  }
  const controller = new AbortController();
  threadsRequest = controller;
  threadsLoading.value = true;
  if (!append) threads.value = [];
  try {
    const value = record(await requestConsole(`${props.channelsBase}/threads`, {
      query: { agent: entry.agent, channel: entry.channel, cursor: append ? threadsCursor.value : undefined },
      signal: controller.signal,
    }));
    const page = list(value.threads).map((thread): ThreadRow => ({
      invocationCount: Number(thread.invocationCount) || 0,
      ...(text(thread.lastMessageAt) ? { lastMessageAt: text(thread.lastMessageAt)! } : {}),
      participants: Array.isArray(thread.participants) ? thread.participants.filter((name): name is string => !!text(name)) : [],
      thread: text(thread.thread) ?? "",
      ...(text(thread.title) ? { title: text(thread.title)! } : {}),
    }));
    threads.value = append ? [...threads.value, ...page] : page;
    threadsCursor.value = text(value.nextCursor);
    error.value = undefined;
  } catch (failure) {
    if (!isAbort(failure)) error.value = failure;
  } finally {
    if (threadsRequest === controller) threadsLoading.value = false;
  }
}

async function loadMessages(append = false): Promise<void> {
  messagesRequest?.abort();
  const entry = selected.value;
  const thread = selectedThread.value;
  if (!entry || !thread) {
    messages.value = [];
    messagesCursor.value = undefined;
    return;
  }
  const controller = new AbortController();
  messagesRequest = controller;
  messagesLoading.value = true;
  if (!append) messages.value = [];
  try {
    const value = record(await requestConsole(`${props.channelsBase}/conversation`, {
      query: { agent: entry.agent, channel: entry.channel, cursor: append ? messagesCursor.value : undefined, thread },
      signal: controller.signal,
    }));
    const page = list(value.messages).map((message): MessageRow => ({
      attachments: list(message.attachments).map(attachment => ({
        ...(text(attachment.mimeType) ? { mimeType: text(attachment.mimeType)! } : {}),
        ...(text(attachment.name) ? { name: text(attachment.name)! } : {}),
        ...(text(attachment.type) ? { type: text(attachment.type)! } : {}),
        ...(text(attachment.url) ? { url: text(attachment.url)! } : {}),
      })),
      ...(text(message.at) ? { at: text(message.at)! } : {}),
      author: { ...(record(message.author).isBot === true ? { isBot: true } : {}), ...(text(record(message.author).name) ? { name: text(record(message.author).name)! } : {}) },
      id: text(message.id) ?? "",
      ...(text(message.invocationId) ? { invocationId: text(message.invocationId)! } : {}),
      role: message.role === "assistant" || message.role === "system" ? message.role : "user",
      source: message.source === "invocation" || message.source === "transcript" ? message.source : "provider",
      text: text(message.text) ?? "",
    }));
    messages.value = append ? [...messages.value, ...page] : page;
    messagesCursor.value = text(value.nextCursor);
    retention.value = parseRetention(value.retention);
    error.value = undefined;
  } catch (failure) {
    if (!isAbort(failure)) error.value = failure;
  } finally {
    if (messagesRequest === controller) messagesLoading.value = false;
  }
}

function select(query: { agent?: string; channel?: string; thread?: string }): void {
  void router.push({ query: { ...query } });
}

function when(value: string | undefined): string {
  const date = value ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "";
}

function view(message: MessageRow): UIMessage {
  return { id: message.id, parts: [{ text: message.text || " ", type: "text" }], role: message.role };
}

function invocationRoute(message: MessageRow): string | undefined {
  const agent = selectedAgent.value;
  return agent && message.invocationId && !message.invocationId.startsWith("invocation:")
    ? router.resolve({ name: "vitehub-console-invocation", params: { agent, invocation: message.invocationId } }).href
    : undefined;
}

function save(name: string, type: string, parts: BlobPart[]): void {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function download(format: "json" | "markdown"): Promise<void> {
  const entry = selected.value;
  const thread = selectedThread.value;
  if (!entry || !thread) return;
  downloading.value = format;
  try {
    const value = record(await requestConsole(`${props.channelsBase}/export`, {
      query: { agent: entry.agent, channel: entry.channel, format, media: format === "json" ? "true" : "false", thread },
    }));
    const name = text(value.filename) ?? (format === "json" ? "history.json" : "conversation.md");
    if (format === "json") {
      // The archive keeps its attachments in media/ files. One download carries their data instead.
      const archive = inlineChannelArchiveMedia(record(JSON.parse(text(value.text) ?? "{}")) as { messages: Record<string, unknown>[] }, list(value.media).map(file => ({ base64: text(file.base64) ?? "", path: text(file.path) ?? "" })));
      save(name, "application/json", [`${JSON.stringify(archive, null, 2)}\n`]);
    } else save(name, "text/markdown", [text(value.text) ?? ""]);
  } catch (failure) {
    error.value = failure;
  } finally {
    downloading.value = undefined;
  }
}

watch(() => [selectedAgent.value, selectedChannel.value], () => void loadThreads());
watch(() => [selectedAgent.value, selectedChannel.value, selectedThread.value], () => void loadMessages());
watch(channels, () => {
  void loadThreads();
  void loadMessages();
});

onMounted(() => {
  rememberConsoleSection("channels");
  void loadChannels();
});

onBeforeUnmount(() => {
  channelsRequest?.abort();
  threadsRequest?.abort();
  messagesRequest?.abort();
});
</script>

<template>
  <ConsoleFrame active="channels" :sections-base="sectionsBase">
    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="channels-conversation" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <ConsolePageHeader title="Channels" :description="selectedThread ?? selected?.channel" :toggle="false">
        <template #right>
          <template v-if="selectedThread">
            <UButton label="Markdown" icon="i-lucide-download" size="sm" variant="outline" color="neutral" :loading="downloading === 'markdown'" :disabled="Boolean(downloading)" @click="download('markdown')" />
            <UButton label="JSON" icon="i-lucide-download" size="sm" variant="outline" color="neutral" :loading="downloading === 'json'" :disabled="Boolean(downloading)" @click="download('json')" />
          </template>
          <UTooltip text="Refresh">
            <UButton aria-label="Refresh" icon="i-lucide-refresh-cw" size="sm" variant="ghost" :loading="channelsLoading || threadsLoading || messagesLoading" @click="loadChannels" />
          </UTooltip>
        </template>
      </ConsolePageHeader>

      <UAlert
        v-if="errorMessage(error)"
        class="m-4"
        color="error"
        variant="subtle"
        icon="i-lucide-cloud-off"
        title="Couldn't load Channels"
        :description="errorMessage(error)"
        :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: loadChannels }]"
      />
      <div v-else class="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav class="flex max-h-[40vh] min-h-0 shrink-0 flex-col gap-1 overflow-y-auto border-b border-default p-2 md:max-h-none md:w-80 md:border-r md:border-b-0" aria-label="Channels and threads">
          <template v-if="channelsLoading && !channels.length">
            <USkeleton v-for="index in 4" :key="index" class="my-0.5 h-10 rounded-md" />
          </template>
          <p v-else-if="!channels.length" class="px-2 py-1.5 text-xs text-muted">No Agent has a Channel yet.</p>
          <template v-else>
            <button
              v-for="entry in channels"
              :key="`${entry.agent}/${entry.channel}`"
              type="button"
              class="vitehub-console__section-link shrink-0 text-start"
              :aria-current="entry === selected && !selectedThread ? 'true' : undefined"
              @click="select({ agent: entry.agent, channel: entry.channel })"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">{{ entry.agent }} · {{ entry.channel }}</span>
                <span class="block truncate text-xs text-muted">{{ entry.provider }}{{ entry.retention.durable ? " · durable" : " · provider window" }}</span>
              </span>
            </button>
          </template>

          <template v-if="selected">
            <p class="mt-3 px-2 text-xs font-medium text-muted">Threads</p>
            <p v-if="!selected.conversations" class="px-2 py-1.5 text-xs text-muted">This Channel has its own history collection and no per-thread conversation.</p>
            <template v-else-if="threadsLoading && !threads.length">
              <USkeleton v-for="index in 4" :key="index" class="my-0.5 h-10 rounded-md" />
            </template>
            <template v-else-if="threads.length">
              <button
                v-for="thread in threads"
                :key="thread.thread"
                type="button"
                class="vitehub-console__section-link shrink-0 text-start"
                :aria-current="thread.thread === selectedThread ? 'true' : undefined"
                :title="thread.thread"
                @click="select({ agent: selected.agent, channel: selected.channel, thread: thread.thread })"
              >
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm">{{ thread.title || thread.participants.join(", ") || thread.thread }}</span>
                  <span class="block truncate text-xs text-muted">
                    {{ thread.invocationCount }} {{ thread.invocationCount === 1 ? "run" : "runs" }}<template v-if="thread.lastMessageAt"> · {{ when(thread.lastMessageAt) }}</template>
                  </span>
                </span>
              </button>
              <UButton v-if="threadsCursor" class="mt-1 self-start" label="Load more" size="sm" variant="ghost" :loading="threadsLoading" @click="loadThreads(true)" />
            </template>
            <p v-else class="px-2 py-1.5 text-xs text-muted">No conversations yet. A thread appears here after an Agent answers in it.</p>
          </template>
        </nav>

        <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-live="polite" aria-label="Conversation">
          <UAlert
            v-if="(retention ?? selected?.retention)?.warning && (selectedThread || selected)"
            class="m-3"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Older messages may be missing"
            :description="(retention ?? selected?.retention)?.warning"
          />
          <div v-if="messagesLoading && !messages.length" class="grid gap-3 p-4" aria-busy="true">
            <USkeleton v-for="index in 5" :key="index" class="h-12" :class="index % 2 ? 'w-2/3' : 'ms-auto w-1/2'" />
          </div>
          <UEmpty
            v-else-if="!selectedThread"
            variant="naked"
            class="py-16"
            icon="i-lucide-messages-square"
            :title="selected ? 'Choose a thread' : 'Choose a Channel'"
            description="Read a whole conversation from the provider history, the transcripts, and the Agent's runs, then download it."
          />
          <UEmpty v-else-if="!messages.length" variant="naked" class="py-16" icon="i-lucide-message-square-off" title="No messages found" description="The provider and the transcripts have nothing for this thread." />
          <ol v-else class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            <li v-for="message in messages" :key="message.id">
              <ChatMessage :message="view(message)">
                <template #header>
                  <span class="text-xs text-muted">{{ message.author.name || (message.role === "assistant" ? "Agent" : "Unknown") }} · {{ when(message.at) }}</span>
                  <ConsoleStatus v-if="message.source !== 'provider'" tone="neutral" :label="message.source === 'transcript' ? 'transcript' : 'from the run'" />
                </template>
                <template #actions>
                  <ul v-if="message.attachments.length" class="flex flex-wrap gap-2 text-xs">
                    <li v-for="(attachment, index) in message.attachments" :key="index" class="flex items-center gap-1 text-muted">
                      <UIcon name="i-lucide-paperclip" class="size-3" />
                      <a v-if="attachment.url && isSafeExternalUrl(attachment.url)" :href="attachment.url" target="_blank" rel="noreferrer noopener" class="underline">{{ attachment.name || attachment.type || "attachment" }}</a>
                      <span v-else>{{ attachment.name || attachment.type || "attachment" }}</span>
                    </li>
                  </ul>
                  <a v-if="invocationRoute(message)" :href="invocationRoute(message)" class="text-xs text-muted underline">Open run</a>
                </template>
              </ChatMessage>
            </li>
            <li v-if="messagesCursor" class="self-center">
              <UButton label="Load more" size="sm" variant="ghost" :loading="messagesLoading" @click="loadMessages(true)" />
            </li>
          </ol>
        </section>
      </div>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
