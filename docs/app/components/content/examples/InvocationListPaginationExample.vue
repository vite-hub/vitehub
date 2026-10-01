<script setup lang="ts">
import type { AgentInvocationListItem, AgentInvocationStatus } from "@vite-hub/ui";
import { onBeforeUnmount, ref } from "vue";

const pageSize = 8;
const total = 32;
const statuses: AgentInvocationStatus[] = ["completed", "completed", "failed", "completed", "cancelled"];
const now = Date.parse("2026-08-23T12:00:00.000Z");

function page(start: number): AgentInvocationListItem[] {
  return Array.from({ length: Math.min(pageSize, total - start) }, (_, offset) => {
    const index = start + offset;
    return {
      id: `invocation-${index}`,
      status: statuses[index % statuses.length]!,
      title: `Nightly dependency review #${total - index}`,
      context: `cursor page ${Math.floor(index / pageSize) + 1}`,
      updatedAt: new Date(now - (index + 1) * 3_600_000).toISOString(),
    };
  });
}

const items = ref(page(0));
const loading = ref(false);
const hasMore = ref(true);
let timeout: ReturnType<typeof setTimeout> | undefined;

// Simulate a cursor request. Append the next page and stop when no page remains.
function loadNextPage() {
  loading.value = true;
  timeout = setTimeout(() => {
    items.value = [...items.value, ...page(items.value.length)];
    hasMore.value = items.value.length < total;
    loading.value = false;
  }, 600);
}

onBeforeUnmount(() => clearTimeout(timeout));
</script>

<template>
  <div class="space-y-2">
    <AgentInvocationList
      :items="items"
      :now="now"
      :has-more="hasMore"
      :loading="loading"
      aria-label="Paginated sessions"
      class="h-72"
      @end-reached="loadNextPage"
    >
      <template #footer>
        <p v-if="!hasMore" class="px-3 py-2 text-center text-xs text-muted">All {{ total }} sessions loaded.</p>
      </template>
    </AgentInvocationList>
    <p class="font-mono text-xs text-muted">{{ items.length }} of {{ total }} loaded</p>
  </div>
</template>
