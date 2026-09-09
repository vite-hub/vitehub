<script setup lang="ts">
defineProps<{ compact?: boolean; retrying?: boolean }>();
defineEmits<{ retry: []; openSessions: [] }>();
</script>

<template>
  <div
    role="alert"
    class="relative w-full shrink-0"
    :class="compact
      ? 'flex items-center gap-3 border-b border-default px-5 py-3'
      : 'flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center'"
  >
    <UButton
      v-if="!compact"
      class="absolute left-3 top-3 md:hidden"
      icon="i-lucide-menu"
      color="neutral"
      variant="ghost"
      size="xs"
      aria-label="Open sessions"
      @click="$emit('openSessions')"
    />
    <UIcon name="i-lucide-wifi-off" class="shrink-0 text-muted" :class="compact ? 'size-4' : 'mb-1 size-5'" />
    <div :class="compact ? 'min-w-0 flex-1' : 'max-w-xs'">
      <h2 class="text-sm font-medium text-highlighted">{{ compact ? 'Connection lost' : 'Unable to connect' }}</h2>
      <p class="mt-1 text-xs leading-5 text-muted">
        {{ compact
          ? 'Showing the last loaded session. Reconnect to get updates.'
          : 'The agent server may be restarting or offline. Try reconnecting in a moment.' }}
      </p>
    </div>
    <UButton
      :label="retrying ? 'Reconnecting…' : 'Reconnect'"
      icon="i-lucide-refresh-cw"
      color="neutral"
      variant="soft"
      size="xs"
      :disabled="retrying"
      @click="$emit('retry')"
    />
  </div>
</template>
