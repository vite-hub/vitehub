<script setup lang="ts">
import { consoleNumber } from "../client/format";
import { computed } from "vue";
import type { AuthConsoleDescription, AuthConsoleOverview } from "@vite-hub/auth/console";
import ConsoleAuthChart from "./console-auth-chart.vue";
import ConsoleAuthEventList from "./console-auth-event-list.vue";
import ConsoleAuthEventSetup from "./console-auth-event-setup.vue";
import ConsoleSection from "./console-section.vue";
import ConsoleStatGrid from "./console-stat-grid.vue";

const props = defineProps<{ data: AuthConsoleOverview; description: AuthConsoleDescription }>();
const metric = (value: number | null) => (value === null ? "Unavailable" : consoleNumber(value));
const metrics = computed(() => [
  { label: "Users", value: metric(props.data.users) },
  { label: "Active in last 7 days", value: metric(props.data.activeUsers) },
  { label: "New in last 7 days", value: metric(props.data.newUsers) },
  { label: "Active sessions", value: metric(props.data.activeSessions) },
  ...(props.data.approvedAgents !== undefined
    ? [{ label: "Approved agents", value: metric(props.data.approvedAgents) }]
    : []),
]);
const methods = computed(() =>
  Object.entries(props.data.analytics?.totals.methods ?? {}).sort((a, b) => b[1] - a[1]),
);
const methodLabel = (method: string) =>
  method === "email-password"
    ? "Email and password"
    : method.startsWith("oauth:")
      ? method.slice(6)
      : method.replaceAll("-", " ");
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto w-full max-w-6xl sm:p-2">
    <ConsoleStatGrid :items="metrics" size="lg" :columns="5" label="Auth totals" class="border-b border-default p-4" />
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
        <ConsoleSection title="Sign-in methods" description="Last 30 days">
          <UEmpty v-if="!methods.length" variant="naked" size="sm" icon="i-lucide-log-in" title="No sign-ins recorded yet" description="Each sign-in method shows here with its share after the first sign-in." />
          <ul class="space-y-4">
            <li v-for="[method, count] in methods" :key="method" class="space-y-1.5">
              <div class="flex items-baseline justify-between gap-2 text-xs">
                <span class="truncate text-toned" :title="method">{{ methodLabel(method) }}</span
                ><span class="whitespace-nowrap tabular-nums text-muted"
                  >{{ consoleNumber(count) }} ·
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
        </ConsoleSection>
      </div>
      <ConsoleSection title="Recent activity" class="border-t border-default px-4 pt-3">
        <template #actions>
          <UButton
            :to="{ name: 'vitehub-console-auth', params: { page: 'activity' } }"
            variant="ghost"
            size="xs"
            trailing-icon="i-lucide-arrow-right"
            >View activity</UButton
          >
        </template>
        <!-- The event rows have their own inline padding, so the list spans the section. -->
        <ConsoleAuthEventList :events="data.recent.events" class="-mx-4" />
        <UEmpty v-if="!data.recent.events.length" variant="naked" size="sm" icon="i-lucide-history" title="No auth events yet" description="Sign-ins, sign-ups, and admin actions show here when they happen." />
      </ConsoleSection>
    </template>
    <p
      v-if="data.activeSessions === null && description.storage.enabled"
      class="p-4 text-xs text-muted"
    >
      Active sessions are unavailable because this app stores sessions only in secondary storage.
    </p>
    </div>
  </div>
</template>
