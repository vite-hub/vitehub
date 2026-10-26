<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type { AuthConsoleActivity } from "@vite-hub/auth/console";
import { readAuthConsole } from "../client/auth-management";
import ConsoleAuthEventList from "./console-auth-event-list.vue";
import ConsoleState from "./console-state.vue";

const props = defineProps<{ base: string; userId: string; revision: number }>();
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
      props.base,
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
  <section aria-labelledby="auth-user-events">
    <div class="flex items-center justify-between px-4 pt-4">
      <h2 id="auth-user-events" class="font-medium text-highlighted">Recent activity</h2>
      <UButton
        :to="{ name: 'vitehub-console-auth', params: { page: 'activity' }, query: { userId } }"
        color="neutral"
        variant="ghost"
        size="xs"
        >View all</UButton
      >
    </div>
    <ConsoleState v-if="error" :error="error" title="Could not load activity" :retry="refresh" />
    <p v-else-if="loading" role="status" class="p-4 text-muted">Loading activity…</p>
    <template v-else-if="data"
      ><ConsoleAuthEventList :events="data.events" compact />
      <p v-if="!data.events.length" class="p-4 text-muted">
        No events recorded for this user.
      </p></template
    >
  </section>
</template>
