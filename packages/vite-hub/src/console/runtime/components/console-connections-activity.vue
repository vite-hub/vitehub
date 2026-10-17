<script setup lang="ts">
import { onMounted, ref } from "vue";
import type * as v from "valibot";
import {
  connectionActivityLabel,
  connectionActivitySchema,
  requestConnectionsManagement,
} from "../client/connections-management";
import ConsoleState from "./console-state.vue";
const props = defineProps<{ endpoint: string; name: string }>();
const events = ref<v.InferOutput<typeof connectionActivitySchema>["activity"]>([]);
const busy = ref(false);
const error = ref<unknown>();
const more = ref(false);
async function load(append = false) {
  busy.value = true;
  error.value = undefined;
  try {
    const result = await requestConnectionsManagement(
      props.endpoint,
      "activity",
      connectionActivitySchema,
      { name: props.name, ...(append ? { before: events.value.at(-1)?.id } : {}) },
    );
    events.value = append ? [...events.value, ...result.activity] : result.activity;
    more.value = result.activity.length === 100;
  } catch (cause) {
    error.value = cause;
  } finally {
    busy.value = false;
  }
}
onMounted(() => load());
</script>
<template>
  <div class="space-y-4">
    <div class="flex items-start justify-between gap-3">
      <p class="text-xs text-muted">Persisted operations. Call inputs are not recorded.</p>
      <UButton label="Refresh" color="neutral" variant="ghost" :loading="busy" @click="load()" />
    </div>
    <ConsoleState v-if="error" compact :error="error" title="Could not load activity" />
    <p v-if="!events.length && !busy && !error" class="text-sm text-muted">No activity yet. Calls, writes, and account changes appear here.</p>
    <ol role="list" class="divide-y divide-default">
      <li v-for="event in events" :key="event.id" class="space-y-1 py-3 text-xs">
        <div class="flex flex-wrap justify-between gap-2">
          <span class="text-highlighted"
            >{{ connectionActivityLabel(event.action)
            }}<template v-if="event.operation"> · {{ event.operation }}</template></span
          ><span
            :class="
              event.outcome === 'failed' || event.outcome === 'denied' ? 'text-error' : 'text-muted'
            "
            >{{ event.outcome }}</span
          >
        </div>
        <p class="break-all text-muted">{{ event.actor.kind }} · {{ event.actor.id }}</p>
        <time :datetime="event.timestamp" class="text-muted tabular-nums">{{
          new Date(event.timestamp).toLocaleString()
        }}</time>
        <p v-if="event.traceId" class="break-all font-mono text-muted">Trace {{ event.traceId }}</p>
        <p v-if="event.invocationId" class="break-all font-mono text-muted">
          Invocation {{ event.invocationId }}
        </p>
      </li>
    </ol>
    <UButton
      v-if="more"
      label="Load older activity"
      color="neutral"
      variant="outline"
      :loading="busy"
      @click="load(true)"
    />
  </div>
</template>
