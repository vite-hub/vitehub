<script setup lang="ts">
import { onMounted, ref } from "vue";
import type * as v from "valibot";
import { envActivitySchema, requestEnvManagement } from "../client/env-management";
const props = defineProps<{ endpoint: string; path: string }>();
const events = ref<v.InferOutput<typeof envActivitySchema>["events"]>([]);
const busy = ref(false);
const error = ref("");
const more = ref(false);
async function load(append = false) {
  busy.value = true;
  error.value = "";
  try {
    const result = await requestEnvManagement(
      props.endpoint,
      props.path,
      "activity",
      envActivitySchema,
      append ? { before: events.value.at(-1)?.id } : {},
    );
    events.value = append ? [...events.value, ...result.events] : result.events;
    more.value = result.events.length === 100;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not load activity.";
  } finally {
    busy.value = false;
  }
}
function actionLabel(action: string) {
  return action === "resolve"
    ? "Retrieve credential"
    : action === "use"
      ? "Use credential"
      : action;
}
onMounted(() => load());
</script>
<template>
  <div class="space-y-4">
    <div class="flex items-start justify-between gap-3">
      <p class="text-xs text-muted">
        Persisted operations. Retrieval does not mean a credential was used.
      </p>
      <UButton label="Refresh" color="neutral" variant="ghost" :loading="busy" @click="load()" />
    </div>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <p v-if="!events.length && !busy && !error" class="text-sm text-muted">No recorded activity.</p>
    <ol role="list" class="divide-y divide-default">
      <li v-for="event in events" :key="event.id" class="space-y-1 py-3 text-xs">
        <div class="flex flex-wrap justify-between gap-2">
          <span class="text-highlighted"
            >{{ actionLabel(event.action)
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
        <p v-if="event.target" class="break-all text-muted">
          {{ event.target.kind }} · {{ event.target.id
          }}<template v-if="event.permissions"> · {{ event.permissions.join(", ") }}</template>
        </p>
        <p v-if="event.revision" class="break-all font-mono text-muted">
          Revision {{ event.revision }}
        </p>
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
