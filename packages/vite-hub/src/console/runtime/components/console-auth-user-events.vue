<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type { AuthConsoleActivity } from "@vite-hub/auth/console";
import { readAuthConsole } from "../client/auth-management";
import ConsoleAuthEventList from "./console-auth-event-list.vue";
import ConsoleState from "./console-state.vue";
import ConsoleSection from "./console-section.vue";

const props = defineProps<{ userId: string; revision: number }>();
const data = shallowRef<AuthConsoleActivity>();
const error = shallowRef<unknown>();
const loading = ref(false);
let controller: AbortController | undefined;
async function refresh() {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  error.value = undefined;
  try {
    const result = await readAuthConsole(
      "activity",
      { activity: { userId: props.userId, limit: 8 } },
      current.signal,
    );
    if (!current.signal.aborted) data.value = result;
  } catch (cause) {
    if (!current.signal.aborted) error.value = cause;
  } finally {
    if (!current.signal.aborted) loading.value = false;
  }
}
watch(
  () => [props.userId, props.revision],
  () => {
    data.value = undefined;
    void refresh();
  },
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <ConsoleSection :level="3" title="Recent activity" class="p-4">
    <template #actions>
      <UButton
        :to="{ name: 'vitehub-console-auth', params: { page: 'activity' }, query: { userId } }"
        variant="ghost"
        size="xs"
        >View all</UButton
      >
    </template>
    <ConsoleState v-if="error" :error="error" title="Could not load activity" :retry="refresh" />
    <p v-else-if="loading" role="status" class="text-muted">Loading activity…</p>
    <template v-else-if="data">
      <!-- The event rows have their own inline padding, so the list spans the section. -->
      <ConsoleAuthEventList :events="data.events" compact class="-mx-4" />
      <UEmpty v-if="!data.events.length" variant="naked" size="sm" icon="i-lucide-history" title="No events for this user" description="Sign-ins and admin actions on this user show here." />
    </template>
  </ConsoleSection>
</template>
