<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { AuthConsoleActivity, AuthConsoleActivityQuery } from "@vite-hub/auth/console";
import { readAuthConsole } from "../client/auth-management";
import { querySelection, useConsoleQuery } from "../client/route-query";
import ConsoleAuthEventList from "./console-auth-event-list.vue";
import ConsoleAuthEventSetup from "./console-auth-event-setup.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsoleState from "./console-state.vue";

const props = defineProps<{ enabled: boolean; revision: number }>();
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
// The page cursor lives in the URL, so a reload or a shared link opens the same page of events.
const { cursor } = useConsoleQuery({ cursor: querySelection() });
// Cursors of the pages up to the open one. A page opened from a link knows only its own cursor.
const cursors = ref<Array<string | undefined>>([cursor.value]);
const page = computed(() => Math.max(0, cursors.value.indexOf(cursor.value)));
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
      "activity",
      {
        activity: {
          group:
            group.value === "all" ? undefined : (group.value as AuthConsoleActivityQuery["group"]),
          userId: userId.value || undefined,
          cursor: cursor.value,
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
      cursor: undefined,
      group: nextGroup === "all" ? undefined : nextGroup,
      userId: nextUser.trim() || undefined,
    },
  });
}
function next() {
  if (!data.value?.nextCursor || loading.value) return;
  cursors.value = [...cursors.value.slice(0, page.value + 1), data.value.nextCursor];
  cursor.value = data.value.nextCursor;
}
function previous() {
  if (!cursor.value || loading.value) return;
  // A page opened from a link goes back to the newest events.
  cursor.value = page.value ? cursors.value[page.value - 1] : undefined;
}
watch(
  () => [props.enabled, props.revision, group.value, userId.value, cursor.value],
  () => {
    userInput.value = userId.value;
    if (!cursors.value.includes(cursor.value)) cursors.value = [cursor.value];
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
    <ConsolePageToolbar width="page">
      <form class="contents" @submit.prevent="filter(group, userInput)">
        <USelect
          :model-value="group"
          :items="groups"
          aria-label="Event type group"
          class="w-40"
          @update:model-value="filter(String($event), userId)"
        />
        <UInput
          v-model="userInput"
          aria-label="Filter by subject user ID"
          placeholder="Subject user ID"
          class="min-w-40 flex-1 sm:max-w-64"
        />
        <UButton type="submit" variant="ghost">Apply</UButton>
        <UButton
          v-if="userId || group !== 'all'"
          variant="ghost"
          @click="filter('all', '')"
          >Clear filters</UButton
        >
      </form>
    </ConsolePageToolbar>
    <div class="min-h-0 flex-1 overflow-y-auto" :aria-busy="loading">
      <div class="vitehub-console-page flex flex-col gap-3">
      <ConsoleState v-if="error" :error="error" title="Could not load activity" :retry="load" />
      <p v-else-if="loading" role="status" class="text-sm text-muted">Loading activity…</p>
      <div v-else-if="data" class="overflow-hidden rounded-lg border border-default">
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
      <span class="tabular-nums">{{ cursors[0] === undefined ? `Page ${page + 1} · ` : "" }}Newest first</span>
      <div class="flex gap-1">
        <UButton
          variant="ghost"
          size="xs"
          :disabled="loading || !cursor"
          @click="previous"
          >Previous</UButton
        ><UButton
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
