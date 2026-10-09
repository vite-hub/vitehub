<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

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

const linkCopy = ref<"copied" | "failed">();
let linkCopyTimer: ReturnType<typeof setTimeout> | undefined;
const linkCopyLabel = computed(() =>
  linkCopy.value === "copied" ? "Link copied" : linkCopy.value === "failed" ? "Could not copy link" : "Copy session link",
);

async function copySessionLink(): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(window.location.href);
    linkCopy.value = "copied";
  } catch {
    linkCopy.value = "failed";
  }
  if (linkCopyTimer) clearTimeout(linkCopyTimer);
  linkCopyTimer = setTimeout(() => (linkCopy.value = undefined), 2_000);
}

onBeforeUnmount(() => {
  if (linkCopyTimer) clearTimeout(linkCopyTimer);
});
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
        <span v-if="project" class="max-w-40 shrink-0 truncate font-normal text-muted">{{
          project
        }}</span>
        <span v-if="project" class="text-dimmed" aria-hidden="true">/</span>
        <strong class="min-w-0 truncate font-medium text-highlighted">{{ title }}</strong>
      </div>
      <span v-else class="text-sm font-medium">{{ title }}</span>
    </template>
    <template #leading>
      <UTooltip text="Open sessions">
        <UButton
          data-slot="mobile-session-navigation"
          class="md:hidden"
          icon="i-lucide-menu"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Open sessions"
          @click="$emit('openSessions')"
        />
      </UTooltip>
    </template>
    <template #right>
      <span class="sr-only" role="status" aria-live="polite">{{ linkCopy ? linkCopyLabel : "" }}</span>
      <UTooltip v-if="hasSelection" :text="linkCopyLabel">
        <UButton
          :icon="linkCopy === 'copied' ? 'i-lucide-check' : 'i-lucide-link'"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="linkCopyLabel"
          @click="copySessionLink"
        />
      </UTooltip>
      <UTooltip v-if="externalUrl && externalTarget" :text="externalTarget.label">
        <UButton
          :to="externalUrl"
          target="_blank"
          :icon="externalTarget.icon"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="externalTarget.label"
        />
      </UTooltip>
      <slot name="actions" />
      <UTooltip v-if="refreshable" text="Refresh session">
        <UButton
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="loading"
          aria-label="Refresh session"
          @click="$emit('refresh')"
        />
      </UTooltip>
      <UTooltip :text="hasSelection ? 'Session details' : 'Select a session to inspect'">
        <UButton
          data-slot="session-details-toggle"
          icon="i-lucide-panel-right"
          color="neutral"
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
