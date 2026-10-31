<script setup lang="ts">
import type { AuthConsoleEvent } from "@vite-hub/auth/console";
import ConsoleRelativeTime from "./console-relative-time.vue";

defineProps<{ events: AuthConsoleEvent[]; compact?: boolean }>();
const labels: Record<AuthConsoleEvent["type"], string> = {
  "user.signed_up": "Signed up",
  "user.signed_in": "Signed in",
  "user.signed_out": "Signed out",
  "sign_in.failed": "Sign-in failed",
  "session.revoked": "Session revoked",
  "user.banned": "User banned",
  "user.unbanned": "User unbanned",
  "user.role_changed": "Role changed",
  "user.updated": "User updated",
  "user.removed": "User removed",
  "impersonation.started": "Impersonation started",
  "impersonation.stopped": "Impersonation stopped",
  "oauth.consent_granted": "Agent approved",
  "oauth.consent_revoked": "Agent approval revoked",
  "organization.member_added": "Member added",
  "organization.member_removed": "Member removed",
  "organization.member_role_changed": "Member role changed",
};
</script>

<template>
  <ol class="divide-y divide-default" aria-label="Auth events">
    <li
      v-for="event in events"
      :key="event.id"
      class="grid gap-x-4 gap-y-1 px-4 py-3 text-sm"
      :class="
        compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-baseline'
      "
    >
      <span class="font-medium text-highlighted">{{ labels[event.type] }}</span>
      <span class="flex min-w-0 flex-wrap items-baseline gap-x-1 text-muted">
        <span class="text-xs">Actor</span>
        <RouterLink
          v-if="event.actor?.available"
          :to="{
            name: 'vitehub-console-auth',
            params: { page: 'users' },
            query: { user: event.actor.id },
          }"
          class="break-all rounded-sm text-toned underline decoration-default underline-offset-2 focus-visible:outline-primary"
          >{{ event.actor.name }}</RouterLink
        >
        <span
          v-else
          class="break-all"
          :title="event.actor ? 'User record is unavailable' : undefined"
          >{{ event.actor?.name ?? "System" }}</span
        >
        <span class="mx-1 text-xs">Subject</span>
        <RouterLink
          v-if="event.subject?.available"
          :to="{
            name: 'vitehub-console-auth',
            params: { page: 'users' },
            query: { user: event.subject.id },
          }"
          class="break-all rounded-sm text-toned underline decoration-default underline-offset-2 focus-visible:outline-primary"
          >{{ event.subject.name }}</RouterLink
        >
        <span
          v-else
          class="break-all"
          :title="event.subject ? 'User record is unavailable' : undefined"
          >{{ event.subject?.name ?? "Unknown" }}</span
        >
      </span>
      <span class="whitespace-nowrap text-xs text-muted"
        ><ConsoleRelativeTime :value="event.time"
      /></span>
    </li>
  </ol>
</template>
