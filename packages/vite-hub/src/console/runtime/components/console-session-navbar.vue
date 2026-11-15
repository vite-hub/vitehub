<script setup lang="ts">
import { computed } from "vue";
import ConsoleAppCrumb from "./console-app-crumb.vue";
import ConsoleSessionCopyLink from "./console-session-copy-link.vue";
import ConsoleSidebarTrigger from "./console-sidebar-trigger.vue";

const props = defineProps<{
  cost?: string;
  detailsOpen: boolean;
  externalUrl?: string;
  hasDisplay: boolean;
  hasSelection: boolean;
  loading: boolean;
  refreshable: boolean;
  project: string;
  title: string;
  tokens?: string;
}>();

const externalTarget = computed(() => {
  if (!props.externalUrl) return;
  try {
    const host = new URL(props.externalUrl).hostname.toLowerCase();
    if (host === "github.com" || host.endsWith(".github.com"))
      return { icon: "i-lucide-github", label: "Open on GitHub" };
  } catch {
    // Keep malformed or relative consumer links usable with the generic action.
  }
  return { icon: "i-lucide-external-link", label: "Open related page" };
});

defineEmits<{
  openSessions: [];
  refresh: [];
  toggleDetails: [];
}>();
</script>

<template>
  <UDashboardNavbar
    class="vitehub-console__session-navbar"
    :title="title"
    :toggle="false"
    :ui="{ root: 'border-0', title: 'min-w-0 flex-1' }"
  >
    <template #title>
      <div v-if="hasDisplay" class="flex min-w-0 items-center gap-2 text-sm">
        <ConsoleAppCrumb />
        <!-- A phone shows only the session title. The sessions menu names the Agent, as page headers hide their trail. -->
        <span v-if="project" class="hidden max-w-40 shrink-0 truncate font-normal text-muted sm:inline">{{
          project
        }}</span>
        <span v-if="project" class="hidden text-dimmed sm:inline" aria-hidden="true">/</span>
        <strong class="min-w-0 truncate font-medium text-highlighted">{{ title }}</strong>
      </div>
      <span v-else class="text-sm font-medium">{{ title }}</span>
    </template>
    <template #leading>
      <ConsoleSidebarTrigger />
      <UTooltip text="Open sessions">
        <UButton
          data-slot="mobile-session-navigation"
          class="md:hidden"
          icon="i-lucide-menu"
          variant="ghost"
          size="xs"
          aria-label="Open sessions"
          @click="$emit('openSessions')"
        />
      </UTooltip>
    </template>
    <template #right>
      <ConsoleSessionCopyLink v-if="hasSelection" />
      <UTooltip v-if="externalUrl && externalTarget" :text="externalTarget.label">
        <UButton
          :to="externalUrl"
          target="_blank"
          :icon="externalTarget.icon"
          variant="ghost"
          size="xs"
          :aria-label="externalTarget.label"
        />
      </UTooltip>
      <slot name="actions" />
      <UTooltip v-if="refreshable" text="Refresh session">
        <UButton
          icon="i-lucide-refresh-cw"
          variant="ghost"
          size="xs"
          :loading="loading"
          aria-label="Refresh session"
          @click="$emit('refresh')"
        />
      </UTooltip>
      <!-- The last header button, as in an editor. The header spans the details panel, so the toggle keeps its place. -->
      <UTooltip :text="hasSelection ? (detailsOpen ? 'Hide session details' : 'Show session details') : 'Select a session to inspect'">
        <UButton
          data-slot="session-details-toggle"
          icon="i-lucide-panel-right"
          :variant="detailsOpen ? 'soft' : 'ghost'"
          size="xs"
          :disabled="!hasSelection"
          aria-label="Session details"
          :aria-pressed="detailsOpen"
          @click="$emit('toggleDetails')"
        />
      </UTooltip>
    </template>
  </UDashboardNavbar>
</template>

<style>
/*
 * The header icons are 22px, half of what a finger needs. On a touch screen each one takes the full 44px header height
 * and half of the 6px gap to its neighbors, so taps do not miss and never land on the next button.
 * Devices with only fine pointers keep 22px.
 */
@media (any-pointer: coarse) {
  .vitehub-console__session-navbar :is(a, button) {
    position: relative;
  }

  .vitehub-console__session-navbar :is(a, button)::before {
    content: "";
    inset: -0.6875rem -0.1875rem;
    position: absolute;
  }
}
</style>
