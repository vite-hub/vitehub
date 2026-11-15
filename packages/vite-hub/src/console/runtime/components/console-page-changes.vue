<script setup lang="ts">
import { computed, ref } from "vue";

import { requestConsoleOperation } from "../client/request";
import { invocationPageChangeViews } from "./invocation/internal/invocation-page-changes";

import type { AgentInvocationView } from "./invocation";
import type { InvocationPageChangeView } from "./invocation/internal/invocation-page-changes";

const props = defineProps<{ invocation: AgentInvocationView }>();
const emit = defineEmits<{ refresh: [] }>();

const changes = computed(() => invocationPageChangeViews(props.invocation.observations));
const pending = ref<string>();
const notices = ref<Record<string, { error: boolean; text: string }>>({});

const time = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
function when(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : time.format(date);
}
function value(item: unknown): string {
  if (item === undefined) return "unset";
  if (typeof item === "string") return item === "" ? "empty" : item;
  return JSON.stringify(item) ?? String(item);
}

async function undo(change: InvocationPageChangeView): Promise<void> {
  if (pending.value) return;
  pending.value = change.id;
  try {
    const result = await requestConsoleOperation("invocations.undo", { change: change.id, id: props.invocation.id });
    const outcome = result && typeof result === "object" ? result : {};
    const restored = "ok" in outcome && outcome.ok === true;
    const reason = "code" in outcome && outcome.code === "REALTIME_ROOM_EMPTY"
      ? "The page is closed, so its value cannot be put back."
      : "The person changed this field after the Agent, so it stays.";
    notices.value = { ...notices.value, [change.id]: restored ? { error: false, text: "Put back on the page." } : { error: true, text: reason } };
    emit("refresh");
  }
  catch (error) {
    notices.value = { ...notices.value, [change.id]: { error: true, text: error instanceof Error && error.message ? error.message : "The change could not be undone." } };
  }
  finally {
    pending.value = undefined;
  }
}
</script>

<template>
  <section class="console-page-changes" aria-label="Page changes">
    <header class="console-page-changes__header">
      <h3 class="console-page-changes__title">Page changes</h3>
      <p class="console-page-changes__hint">What the Agent changed on the person's page. Undo puts a value back while the page is open and the field still shows the Agent's value. It does not undo a save.</p>
    </header>
    <p v-if="!changes.length" class="console-page-changes__empty">This session changed nothing on a page.</p>
    <ol v-else class="console-page-changes__list">
      <li v-for="change in changes" :key="change.id" class="console-page-changes__row" :data-undone="change.undone ? '' : undefined">
        <div class="console-page-changes__main">
          <p class="console-page-changes__what">
            <span class="console-page-changes__label">{{ change.label ?? change.ref }}</span>
            <span class="console-page-changes__key">{{ change.key }}</span>
          </p>
          <p v-if="change.valuesOmitted" class="console-page-changes__values console-page-changes__values--omitted">Values omitted by the journal</p>
          <p v-else class="console-page-changes__values">
            <span class="console-page-changes__before">{{ value(change.before) }}</span>
            <span aria-hidden="true">→</span>
            <span class="sr-only">to</span>
            <span class="console-page-changes__after">{{ value(change.after) }}</span>
          </p>
          <p class="console-page-changes__meta">
            <time :datetime="change.at">{{ when(change.at) }}</time>
            <span>Step {{ change.step + 1 }}</span>
            <span :title="change.page">Page {{ change.page.slice(0, 8) }}</span>
            <span :title="change.user">{{ change.user === "anonymous" ? "Anonymous" : `Person ${change.user.slice(0, 8)}` }}</span>
          </p>
          <p v-if="notices[change.id]" class="console-page-changes__notice" :class="notices[change.id]!.error ? 'text-error' : 'text-success'" role="status">{{ notices[change.id]!.text }}</p>
        </div>
        <span v-if="change.undone" class="console-page-changes__undone">Undone</span>
        <UButton
          v-else
          data-slot="page-change-undo"
          icon="i-lucide-undo-2"
          size="xs"
          color="neutral"
          variant="outline"
          :loading="pending === change.id"
          :disabled="!!pending"
          :aria-label="`Undo ${change.label ?? change.ref}`"
          @click="undo(change)"
        >
          Undo
        </UButton>
      </li>
    </ol>
  </section>
</template>

<style>
.console-page-changes {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
  overflow: auto;
  padding: 1rem;
}

.console-page-changes__title {
  font-size: 0.875rem;
  font-weight: 600;
}

.console-page-changes__hint,
.console-page-changes__empty,
.console-page-changes__meta {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
}

.console-page-changes__list {
  display: flex;
  flex-direction: column;
}

.console-page-changes__row {
  align-items: flex-start;
  border-top: 1px solid var(--ui-border);
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
  padding-block: 0.625rem;
}

.console-page-changes__row:first-child {
  border-top: 0;
}

.console-page-changes__main {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}

.console-page-changes__what {
  align-items: baseline;
  display: flex;
  gap: 0.5rem;
  font-size: 0.8125rem;
}

.console-page-changes__label {
  font-weight: 500;
}

.console-page-changes__key {
  color: var(--ui-text-dimmed);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
}

.console-page-changes__values {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  gap: 0.375rem;
}

.console-page-changes__before {
  color: var(--ui-text-muted);
  text-decoration: line-through;
}

.console-page-changes__row[data-undone] .console-page-changes__before {
  text-decoration: none;
}

.console-page-changes__row[data-undone] .console-page-changes__after {
  color: var(--ui-text-muted);
  text-decoration: line-through;
}

.console-page-changes__values--omitted {
  color: var(--ui-text-dimmed);
  font-family: inherit;
}

.console-page-changes__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.console-page-changes__notice {
  font-size: 0.75rem;
}

.console-page-changes__undone {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  padding-top: 0.125rem;
}
</style>
