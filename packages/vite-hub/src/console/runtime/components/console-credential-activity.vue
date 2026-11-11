<script setup lang="ts">
import type { EnvActivity } from "@vite-hub/env/bridge";
import { onMounted, ref } from "vue";
import { consoleDateTime } from "../client/format";
import ConsoleActivityFeed from "./console-activity-feed.vue";

/**
 * The persisted operations on one credential, newest first: an Env value or the token of a Connection. Both stores
 * record the same events and return pages of 100, so `load` only names the request.
 */
const props = defineProps<{
  description: string;
  emptyDescription: string;
  emptyTitle: string;
  /** A short name for each action, such as "Retrieve credential". */
  label: (action: EnvActivity["action"]) => string;
  /** Loads the page of events older than the event `before`, or the newest page. */
  load: (before?: string) => Promise<readonly EnvActivity[]>;
}>();
const pageSize = 100;
const events = ref<readonly EnvActivity[]>([]);
const busy = ref(false);
const error = ref<unknown>();
const more = ref(false);
async function load(append = false) {
  busy.value = true;
  error.value = undefined;
  try {
    const page = await props.load(append ? events.value.at(-1)?.id : undefined);
    events.value = append ? [...events.value, ...page] : page;
    more.value = page.length === pageSize;
  } catch (cause) {
    error.value = cause;
  } finally {
    busy.value = false;
  }
}
onMounted(() => load());
</script>

<template>
  <ConsoleActivityFeed
    :description="description"
    :items="events"
    :item-key="(event) => event.id"
    :loading="busy"
    :error="error"
    error-title="Could not load activity"
    :empty-title="emptyTitle"
    :empty-description="emptyDescription"
    empty-icon="i-lucide-history"
    :has-more="more"
    :refresh="() => load()"
    :more="() => load(true)"
  >
    <template #item="{ item: event }">
      <div class="space-y-1">
        <div class="flex flex-wrap justify-between gap-2">
          <span class="text-highlighted"
            >{{ label(event.action) }}<template v-if="event.operation"> · {{ event.operation }}</template></span
          ><span :class="event.outcome === 'failed' || event.outcome === 'denied' ? 'text-error' : 'text-muted'">{{
            event.outcome
          }}</span>
        </div>
        <p class="break-all text-muted">{{ event.actor.kind }} · {{ event.actor.id }}</p>
        <time :datetime="event.timestamp" class="text-muted tabular-nums">{{ consoleDateTime(event.timestamp) }}</time>
        <p v-if="event.target" class="break-all text-muted">
          {{ event.target.kind }} · {{ event.target.id
          }}<template v-if="event.permissions"> · {{ event.permissions.join(", ") }}</template>
        </p>
        <p v-if="event.revision" class="break-all font-mono text-muted">Revision {{ event.revision }}</p>
        <p v-if="event.traceId" class="break-all font-mono text-muted">Trace {{ event.traceId }}</p>
        <p v-if="event.invocationId" class="break-all font-mono text-muted">Invocation {{ event.invocationId }}</p>
      </div>
    </template>
  </ConsoleActivityFeed>
</template>
