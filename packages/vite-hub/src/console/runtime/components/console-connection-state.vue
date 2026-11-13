<script setup lang="ts">
/**
 * The Agent server stopped answering. `compact` is an alert above the last loaded session; without it, the state
 * replaces the empty session view.
 */
defineProps<{ compact?: boolean; retrying?: boolean }>();
defineEmits<{ retry: []; openSessions: [] }>();
</script>

<template>
  <div v-if="compact" class="shrink-0 border-b border-default px-5 py-3">
    <UAlert
      role="alert"
      color="warning"
      icon="i-lucide-wifi-off"
      title="Connection lost"
      description="Showing the last loaded session. Reconnect to get updates."
      orientation="horizontal"
      :actions="[{ label: retrying ? 'Reconnecting…' : 'Reconnect', icon: 'i-lucide-refresh-cw', variant: 'outline', disabled: retrying, onClick: () => $emit('retry') }]"
    />
  </div>
  <div v-else role="alert" class="relative flex h-full min-h-0 w-full shrink-0 flex-col">
    <UButton
      class="absolute left-3 top-3 md:hidden"
      icon="i-lucide-menu"
      variant="ghost"
      size="xs"
      aria-label="Open sessions"
      @click="$emit('openSessions')"
    />
    <UEmpty
      variant="naked"
      icon="i-lucide-wifi-off"
      title="Unable to connect"
      description="The agent server may be restarting or offline. Try reconnecting in a moment."
      :actions="[{ label: retrying ? 'Reconnecting…' : 'Reconnect', icon: 'i-lucide-refresh-cw', variant: 'outline', size: 'xs', disabled: retrying, onClick: () => $emit('retry') }]"
      class="min-h-0 flex-1"
    />
  </div>
</template>
