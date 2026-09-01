<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    error?: string;
    maximizable?: boolean;
    maximized?: boolean;
    surface?: "thread" | "inspector";
  }>(),
  { error: undefined, maximizable: true, maximized: false, surface: "thread" },
);

const emit = defineEmits<{
  close: [];
  retry: [];
  toggleMaximized: [];
}>();
</script>

<template>
  <div
    :aria-label="props.error ? 'Session load failed' : 'Loading session'"
    class="h-full overflow-hidden"
    :role="props.error ? 'alert' : 'status'"
  >
    <template v-if="surface === 'inspector'">
      <header class="session-inspector__header">
        <div class="session-inspector__tabstrip">
          <USkeleton class="h-6 w-28 rounded-md" />
          <UTooltip text="Open inspector view">
            <UButton
              class="session-inspector__icon-button"
              icon="i-lucide-plus"
              color="neutral"
              variant="ghost"
              size="xs"
              disabled
              aria-label="Open inspector view"
            />
          </UTooltip>
        </div>
        <div class="session-inspector__actions">
          <UTooltip :text="props.maximized ? 'Restore split view' : 'Maximize details'">
            <UButton
              class="session-inspector__icon-button"
              :icon="props.maximized ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
              color="neutral"
              variant="ghost"
              size="xs"
              :disabled="!props.maximizable"
              :aria-label="props.maximized ? 'Restore split view' : 'Maximize details'"
              @click="emit('toggleMaximized')"
            />
          </UTooltip>
          <UTooltip text="Close details">
            <UButton
              class="session-inspector__icon-button"
              icon="i-lucide-panel-right-close"
              color="neutral"
              variant="ghost"
              size="xs"
              aria-label="Close details"
              @click="emit('close')"
            />
          </UTooltip>
        </div>
      </header>
      <UEmpty
        v-if="props.error"
        class="h-[calc(100%-3.25rem)] min-h-0"
        icon="i-ph-cloud-slash-light"
        title="Could not load session details"
        :description="props.error"
        :actions="[
          {
            label: 'Try again',
            icon: 'i-ph-arrows-clockwise-light',
            onClick: () => emit('retry'),
          },
        ]"
      />
      <div v-else class="grid gap-8 px-5 py-6">
        <section class="grid gap-3">
          <USkeleton class="h-6 w-28 rounded-md" />
          <USkeleton class="h-4 w-3/4 rounded" />
          <USkeleton class="h-4 w-32 rounded" />
        </section>
        <section class="grid gap-3">
          <USkeleton class="h-3 w-24 rounded" />
          <div class="grid grid-cols-3 gap-2">
            <USkeleton v-for="index in 3" :key="index" class="h-20 rounded-lg" />
          </div>
        </section>
        <section class="grid gap-4">
          <USkeleton class="h-3 w-28 rounded" />
          <div v-for="index in 5" :key="index" class="grid gap-2">
            <USkeleton class="h-4 rounded" :class="index % 2 === 0 ? 'w-2/3' : 'w-1/2'" />
            <USkeleton class="h-1 w-full rounded-full" />
          </div>
        </section>
      </div>
    </template>
    <div v-else class="px-6 py-10 sm:px-10 lg:px-14">
      <div class="mx-auto grid w-full max-w-4xl gap-6">
        <USkeleton class="h-14 rounded-lg" />
        <div class="mx-auto grid w-full max-w-3xl gap-4 rounded-3xl bg-elevated/60 p-7">
          <USkeleton class="h-8 w-44 rounded-md" />
          <USkeleton class="mt-2 h-5 w-4/5 rounded" />
          <USkeleton class="h-5 w-full rounded" />
          <USkeleton class="h-5 w-2/3 rounded" />
        </div>
        <USkeleton class="h-12 rounded-lg" />
        <div class="grid gap-4 px-1">
          <div v-for="index in 4" :key="index" class="grid gap-2">
            <USkeleton class="h-4 rounded" :class="index % 2 === 0 ? 'w-3/5' : 'w-4/5'" />
            <USkeleton class="h-3 w-1/3 rounded" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
