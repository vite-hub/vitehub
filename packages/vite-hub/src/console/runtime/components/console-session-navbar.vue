<script setup lang="ts">
defineProps<{
  detailsOpen: boolean;
  externalUrl?: string;
  hasDisplay: boolean;
  hasSelection: boolean;
  loading: boolean;
  project: string;
  title: string;
}>();

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
    :ui="{ root: 'border-0', title: 'min-w-0 flex-1' }"
  >
    <template #title>
      <div v-if="hasDisplay" class="flex min-w-0 items-center gap-2 text-sm">
        <UIcon name="i-lucide-folder" class="size-3.5 shrink-0 text-muted" />
        <span class="max-w-40 shrink-0 truncate font-normal text-muted">{{ project }}</span>
        <span class="text-dimmed" aria-hidden="true">/</span>
        <strong class="min-w-0 truncate font-medium text-highlighted">{{ title }}</strong>
      </div>
      <span v-else class="text-sm font-medium">{{ title }}</span>
    </template>
    <template #right>
      <UTooltip text="Open sessions">
        <UButton
          data-slot="mobile-session-navigation"
          class="lg:hidden"
          icon="i-lucide-panel-left"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="Open sessions"
          @click="$emit('openSessions')"
        />
      </UTooltip>
      <UTooltip v-if="externalUrl" text="Open related page">
        <UButton
          :to="externalUrl"
          target="_blank"
          icon="i-lucide-external-link"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="Open related page"
        />
      </UTooltip>
      <UTooltip text="Refresh session">
        <UButton
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="ghost"
          size="sm"
          :loading="loading"
          aria-label="Refresh session"
          @click="$emit('refresh')"
        />
      </UTooltip>
      <UTooltip v-if="hasSelection" text="Session details">
        <UButton
          icon="i-lucide-panel-right"
          color="neutral"
          :variant="detailsOpen ? 'soft' : 'ghost'"
          size="sm"
          aria-label="Session details"
          :aria-pressed="detailsOpen"
          @click="$emit('toggleDetails')"
        />
      </UTooltip>
    </template>
  </UDashboardNavbar>
</template>
