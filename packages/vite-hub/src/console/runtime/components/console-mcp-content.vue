<script setup lang="ts">
import { computed, ref } from "vue";

import type { ConsoleMcpOutcome } from "../mcp-client";

/**
 * The answer of one MCP request as the server sent it: text, images, audio, resource links, embedded resources, and
 * structured content, or the JSON-RPC error. "JSON" shows the whole result. Tool results, resource contents, and prompt
 * messages share the content block format, so one renderer serves the three.
 */
const props = defineProps<{ outcome: ConsoleMcpOutcome }>();

type Block = Record<string, unknown>;

const raw = ref(false);
const result = computed(() => props.outcome.result ?? {});
const json = computed(() => JSON.stringify(props.outcome.error ?? props.outcome.result ?? null, null, 2));
const toolError = computed(() => result.value.isError === true);

function record(value: unknown): Block | undefined {
  return value instanceof Object && !Array.isArray(value) ? value as Block : undefined;
}

function blocks(value: unknown): Block[] {
  return Array.isArray(value) ? value.flatMap(entry => record(entry) ?? []) : [];
}

/** Text that holds JSON is shown formatted. Other text stays as it is. */
function pretty(text: string): { json: boolean, text: string } {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return { json: false, text };
  try {
    return { json: true, text: JSON.stringify(JSON.parse(trimmed), null, 2) };
  }
  catch {
    return { json: false, text };
  }
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const content = computed(() => blocks(result.value.content));
const contents = computed(() => blocks(result.value.contents));
const messages = computed(() => blocks(result.value.messages));
const structured = computed(() => result.value.structuredContent === undefined ? undefined : JSON.stringify(result.value.structuredContent, null, 2));
const empty = computed(() => !props.outcome.error && !content.value.length && !contents.value.length && !messages.value.length && structured.value === undefined);

function mediaSource(block: Block): string | undefined {
  const data = string(block.data);
  const type = string(block.mimeType);
  return data && /^(?:image|audio)\/[\w.+-]+$/.test(type) ? `data:${type};base64,${data}` : undefined;
}

function bytes(base64: string): string {
  const size = Math.floor(base64.length * 3 / 4);
  return size < 1_024 ? `${size} B` : `${(size / 1_024).toFixed(1)} KB`;
}
</script>

<template>
  <div class="grid min-w-0 gap-3 text-[13px]">
    <div class="flex items-center gap-2">
      <UBadge v-if="outcome.error" color="error" variant="subtle" size="sm" label="Protocol error" />
      <UBadge v-else-if="toolError" color="error" variant="subtle" size="sm" label="Tool error" />
      <UBadge v-else color="success" variant="subtle" size="sm" label="OK" />
      <span class="text-xs text-dimmed tabular-nums">{{ outcome.durationMs }} ms</span>
      <UButton
        class="ms-auto"
        color="neutral"
        size="xs"
        variant="ghost"
        :aria-pressed="raw"
        :label="raw ? 'Formatted' : 'JSON'"
        :icon="raw ? 'i-lucide-text' : 'i-lucide-braces'"
        @click="raw = !raw"
      />
    </div>

    <pre v-if="raw" class="vitehub-mcp-code">{{ json }}</pre>

    <template v-else>
      <div v-if="outcome.error" role="alert" class="grid gap-1 rounded-md bg-error/8 px-3 py-2.5">
        <p class="font-medium text-highlighted">{{ outcome.error.message }}</p>
        <p class="font-mono text-xs text-muted">JSON-RPC {{ outcome.error.code }}</p>
        <pre v-if="outcome.error.data !== undefined" class="vitehub-mcp-code mt-1">{{ JSON.stringify(outcome.error.data, null, 2) }}</pre>
      </div>

      <p v-if="typeof result.description === 'string' && result.description" class="text-pretty text-muted">{{ result.description }}</p>

      <template v-for="(block, index) in content" :key="`content-${index}`">
        <template v-if="block.type === 'text'">
          <pre :class="pretty(string(block.text)).json ? 'vitehub-mcp-code' : 'vitehub-mcp-text'">{{ pretty(string(block.text)).text }}</pre>
        </template>
        <img v-else-if="block.type === 'image' && mediaSource(block)" :src="mediaSource(block)" alt="Image from the tool result" class="max-h-80 w-fit max-w-full rounded-md outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">
        <audio v-else-if="block.type === 'audio' && mediaSource(block)" :src="mediaSource(block)" controls class="w-full" />
        <div v-else-if="block.type === 'resource_link'" class="flex min-w-0 items-center gap-2 rounded-md border border-default px-3 py-2">
          <UIcon name="i-lucide-link" class="size-4 shrink-0 text-muted" aria-hidden="true" />
          <span class="min-w-0">
            <span class="block truncate font-medium text-highlighted">{{ string(block.title) || string(block.name) }}</span>
            <span class="block truncate font-mono text-xs text-dimmed">{{ string(block.uri) }}</span>
          </span>
        </div>
        <div v-else-if="block.type === 'resource' && record(block.resource)" class="grid gap-1.5">
          <p class="truncate font-mono text-xs text-dimmed">{{ string(record(block.resource)!.uri) }}</p>
          <pre class="vitehub-mcp-text">{{ string(record(block.resource)!.text) || `Binary, ${bytes(string(record(block.resource)!.blob))}` }}</pre>
        </div>
        <pre v-else class="vitehub-mcp-code">{{ JSON.stringify(block, null, 2) }}</pre>
      </template>

      <section v-if="structured !== undefined" class="grid gap-1.5" aria-label="Structured content">
        <h4 class="text-xs font-medium text-muted">Structured content</h4>
        <pre class="vitehub-mcp-code">{{ structured }}</pre>
      </section>

      <div v-for="(entry, index) in contents" :key="`resource-${index}`" class="grid gap-1.5">
        <p class="flex min-w-0 items-center gap-2 text-xs">
          <span class="truncate font-mono text-dimmed">{{ string(entry.uri) }}</span>
          <span v-if="string(entry.mimeType)" class="shrink-0 text-dimmed">{{ string(entry.mimeType) }}</span>
        </p>
        <img v-if="string(entry.blob) && string(entry.mimeType).startsWith('image/')" :src="`data:${string(entry.mimeType)};base64,${string(entry.blob)}`" :alt="string(entry.uri)" class="max-h-80 w-fit max-w-full rounded-md">
        <p v-else-if="string(entry.blob)" class="text-muted">Binary content, {{ bytes(string(entry.blob)) }}.</p>
        <pre v-else :class="pretty(string(entry.text)).json ? 'vitehub-mcp-code' : 'vitehub-mcp-text'">{{ pretty(string(entry.text)).text }}</pre>
      </div>

      <ol v-if="messages.length" class="grid gap-2">
        <li v-for="(message, index) in messages" :key="`message-${index}`" class="grid gap-1 rounded-md border border-default px-3 py-2">
          <span class="text-xs font-medium capitalize text-muted">{{ string(message.role) }}</span>
          <pre class="vitehub-mcp-text">{{ record(message.content)?.type === "text" ? string(record(message.content)!.text) : JSON.stringify(message.content, null, 2) }}</pre>
        </li>
      </ol>

      <p v-if="empty" class="text-muted">The server returned no content.</p>
    </template>
  </div>
</template>

<style>
/* Results are read, copied, and compared, so they keep their line breaks and wrap long lines instead of scrolling. */
.vitehub-mcp-text,
.vitehub-mcp-code {
  background: var(--ui-bg-elevated);
  border-radius: 0.375rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.6;
  max-height: 28rem;
  overflow: auto;
  overflow-wrap: anywhere;
  padding: 0.625rem 0.75rem;
  white-space: pre-wrap;
}

.vitehub-mcp-text {
  background: color-mix(in oklab, var(--ui-bg-elevated) 50%, transparent);
  font-family: var(--font-sans);
  font-size: 0.8125rem;
}
</style>
