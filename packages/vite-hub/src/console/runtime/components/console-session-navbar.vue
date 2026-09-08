<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  cost?: string;
  detailsOpen: boolean;
  externalUrl?: string;
  hasDisplay: boolean;
  hasSelection: boolean;
  loading: boolean;
  project: string;
  title: string;
  tokens?: string;
}>();

const externalTarget = computed(() => {
  if (!props.externalUrl) return;
  try {
    const host = new URL(props.externalUrl).hostname.toLowerCase();
    if (host === "github.com" || host.endsWith(".github.com"))
      return { github: true, icon: undefined, label: "Open on GitHub" };
  } catch {
    // Keep malformed or relative consumer links usable with the generic action.
  }
  return { github: false, icon: "i-lucide-external-link", label: "Open related page" };
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
      <UTooltip v-if="externalUrl && externalTarget" :text="externalTarget.label">
        <UButton
          :to="externalUrl"
          target="_blank"
          :icon="externalTarget.icon"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="externalTarget.label"
        >
          <template v-if="externalTarget.github" #leading>
            <!-- GitHub's official MIT-licensed Octicons mark. -->
            <svg class="size-4 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
            </svg>
          </template>
        </UButton>
      </UTooltip>
      <UTooltip text="Refresh session">
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
