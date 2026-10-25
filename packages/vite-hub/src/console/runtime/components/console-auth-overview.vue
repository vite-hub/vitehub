<script setup lang="ts">
import { computed } from "vue";
import type { AuthConsoleDescription, AuthConsoleOverview } from "@vite-hub/auth/console";
import ConsoleAuthChart from "./console-auth-chart.vue";
import ConsoleAuthEventList from "./console-auth-event-list.vue";
import ConsoleAuthEventSetup from "./console-auth-event-setup.vue";

const props = defineProps<{ data: AuthConsoleOverview; description: AuthConsoleDescription }>();
const metrics = computed(() => [
  { label: "Users", value: props.data.users },
  { label: "Active in last 7 days", value: props.data.activeUsers },
  { label: "New in last 7 days", value: props.data.newUsers },
  { label: "Active sessions", value: props.data.activeSessions },
  ...(props.data.approvedAgents !== undefined
    ? [{ label: "Approved agents", value: props.data.approvedAgents }]
    : []),
]);
const methods = computed(() =>
  Object.entries(props.data.analytics?.totals.methods ?? {}).sort((a, b) => b[1] - a[1]),
);
const format = (value: number) => new Intl.NumberFormat().format(value);
const methodLabel = (method: string) =>
  method === "email-password"
    ? "Email and password"
    : method.startsWith("oauth:")
      ? method.slice(6)
      : method.replaceAll("-", " ");
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <dl class="grid grid-cols-2 gap-5 border-b border-default p-4 lg:grid-cols-5">
      <div v-for="metric in metrics" :key="metric.label">
        <dt class="text-xs text-muted">{{ metric.label }}</dt>
        <dd class="mt-1 text-2xl font-medium tabular-nums text-highlighted">
          {{ metric.value === null ? "Unavailable" : format(metric.value) }}
        </dd>
      </div>
    </dl>
    <p v-if="!description.storage.enabled" class="px-4 pt-3 text-xs text-muted">
      {{ description.storage.reason }}
    </p>
    <ConsoleAuthEventSetup v-if="!data.recent.enabled" />
    <template v-else>
      <p class="px-4 pt-3 text-xs text-muted">
        Active users completed a recorded sign-in. Sessions created at sign-up count. Counts cover
        retained events.
      </p>
      <div
        v-if="data.analytics"
        class="grid gap-6 p-4 lg:grid-cols-[minmax(0,2fr)_minmax(12rem,1fr)]"
      >
        <ConsoleAuthChart :analytics="data.analytics" />
        <section class="min-w-0 space-y-4" aria-labelledby="auth-methods-title">
          <h2 id="auth-methods-title" class="text-sm font-medium text-highlighted">
            Sign-in methods <span class="font-normal text-muted">30 days</span>
          </h2>
          <p v-if="!methods.length" class="text-xs text-muted">No sign-in methods recorded yet.</p>
          <ul class="space-y-4">
            <li v-for="[method, count] in methods" :key="method" class="space-y-1.5">
              <div class="flex items-baseline justify-between gap-2 text-xs">
                <span class="truncate text-toned" :title="method">{{ methodLabel(method) }}</span
                ><span class="whitespace-nowrap tabular-nums text-muted"
                  >{{ format(count) }} ·
                  {{ Math.round((count / data.analytics.totals.signIns) * 100) }}%</span
                >
              </div>
              <div class="h-1 bg-elevated" aria-hidden="true">
                <div
                  class="h-1 bg-primary"
                  :style="{ width: `${(count / data.analytics.totals.signIns) * 100}%` }"
                />
              </div>
            </li>
          </ul>
        </section>
      </div>
      <section aria-labelledby="auth-recent-title">
        <div class="flex items-center justify-between border-y border-default px-4 py-2">
          <h2 id="auth-recent-title" class="text-sm font-medium text-highlighted">
            Recent activity
          </h2>
          <UButton
            :to="{ name: 'vitehub-console-auth', params: { page: 'activity' } }"
            color="neutral"
            variant="ghost"
            size="xs"
            trailing-icon="i-lucide-arrow-right"
            >View activity</UButton
          >
        </div>
        <ConsoleAuthEventList :events="data.recent.events" />
        <p v-if="!data.recent.events.length" class="p-4 text-sm text-muted">
          No auth events recorded yet.
        </p>
      </section>
    </template>
    <p
      v-if="data.activeSessions === null && description.storage.enabled"
      class="p-4 text-xs text-muted"
    >
      Active sessions are unavailable because this app stores sessions only in secondary storage.
    </p>
  </div>
</template>
