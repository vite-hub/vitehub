<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { AuthConsoleActivity, AuthConsoleActivityQuery } from "@vite-hub/auth/console";
import { readAuthConsole } from "../client/auth-management";
import ConsoleAuthEventList from "./console-auth-event-list.vue";
import ConsoleAuthEventSetup from "./console-auth-event-setup.vue";
import ConsoleState from "./console-state.vue";

const props = defineProps<{ base: string; enabled: boolean; revision: number }>();
const route = useRoute();
const router = useRouter();
const groups = [
  { label: "All events", value: "all" },
  { label: "Sign-in", value: "sign-in" },
  { label: "Admin actions", value: "admin" },
  { label: "Agents", value: "agents" },
  { label: "Organizations", value: "organizations" },
];
const group = computed(() => (typeof route.query.group === "string" ? route.query.group : "all"));
const userId = computed(() => (typeof route.query.userId === "string" ? route.query.userId : ""));
const userInput = ref(userId.value);
const data = shallowRef<AuthConsoleActivity>();
const error = shallowRef<unknown>();
const loading = ref(false);
const cursors = ref<Array<string | undefined>>([undefined]);
const page = ref(0);
let controller: AbortController | undefined;
async function load() {
  controller?.abort();
  if (!props.enabled) {
    data.value = undefined;
    return;
  }
  const current = new AbortController();
  controller = current;
  loading.value = true;
  error.value = undefined;
  try {
    const result = await readAuthConsole(
      props.base,
      "activity",
      {
        activity: {
          group:
            group.value === "all" ? undefined : (group.value as AuthConsoleActivityQuery["group"]),
          userId: userId.value || undefined,
          cursor: cursors.value[page.value],
          limit: 25,
        },
      },
      current.signal,
    );
    if (!current.signal.aborted) data.value = result;
  } catch (cause) {
    if (!current.signal.aborted) error.value = cause;
  } finally {
    if (!current.signal.aborted) loading.value = false;
  }
}
function filter(nextGroup: string, nextUser: string) {
  void router.replace({
    query: {
      ...route.query,
      group: nextGroup === "all" ? undefined : nextGroup,
      userId: nextUser.trim() || undefined,
    },
  });
}
function next() {
  if (!data.value?.nextCursor || loading.value) return;
  cursors.value[page.value + 1] = data.value.nextCursor;
  page.value++;
  void load();
}
function previous() {
  if (!page.value || loading.value) return;
  page.value--;
  void load();
}
watch(
  () => [props.enabled, props.revision, group.value, userId.value],
  () => {
    userInput.value = userId.value;
    cursors.value = [undefined];
    page.value = 0;
    data.value = undefined;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <ConsoleAuthEventSetup v-if="!enabled" class="overflow-y-auto" />
  <div v-else class="flex min-h-0 flex-1 flex-col">
    <form
      class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-default px-3 py-2 sm:px-4"
      @submit.prevent="filter(group, userInput)"
    >
      <USelect
        :model-value="group"
        :items="groups"
        aria-label="Event type group"
        size="sm"
        class="w-40"
        @update:model-value="filter(String($event), userId)"
      />
      <UInput
        v-model="userInput"
        aria-label="Filter by subject user ID"
        placeholder="Subject user ID"
        size="sm"
        class="min-w-40 flex-1 sm:max-w-64"
      />
      <UButton type="submit" color="neutral" variant="ghost" size="sm">Apply</UButton>
      <UButton
        v-if="userId || group !== 'all'"
        color="neutral"
        variant="ghost"
        size="sm"
        @click="filter('all', '')"
        >Clear filters</UButton
      >
    </form>
    <div class="min-h-0 flex-1 overflow-y-auto" :aria-busy="loading">
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-3 p-4 sm:p-6">
      <ConsoleState v-if="error" :error="error" title="Could not load activity" :retry="load" />
      <p v-else-if="loading" role="status" class="text-sm text-muted">Loading activity…</p>
      <div v-else-if="data" class="overflow-hidden rounded-md border border-default">
        <ConsoleAuthEventList :events="data.events" />
        <p v-if="!data.events.length" class="p-8 text-center text-sm text-muted">
          {{
            userId || group !== "all"
              ? "No events match these filters."
              : "No auth events recorded yet."
          }}
        </p>
      </div>
    <footer
      class="flex items-center justify-between gap-3 text-xs text-muted"
    >
      <span class="tabular-nums">Page {{ page + 1 }} · Newest first</span>
      <div class="flex gap-1">
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="loading || page === 0"
          @click="previous"
          >Previous</UButton
        ><UButton
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="loading || Boolean(error) || !data?.nextCursor"
          @click="next"
          >Next</UButton
        >
      </div>
    </footer>
      </div>
    </div>
  </div>
</template>
