<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: "Opening Console…" });
</script>

<template>
  <div class="vitehub-console-page grid content-start gap-6">
    <p role="status" class="flex items-center gap-2 text-sm text-muted">
      <UIcon
        name="i-lucide-loader-circle"
        class="size-4 motion-safe:animate-spin"
        aria-hidden="true"
      />
      {{ label }}
    </p>
    <div class="grid gap-4" aria-hidden="true">
      <USkeleton class="h-8 w-2/3 animate-none rounded-md" />
      <USkeleton class="h-4 w-1/3 animate-none rounded-md" />
      <div class="mt-4 grid gap-3">
        <USkeleton
          v-for="index in 6"
          :key="index"
          class="h-4 animate-none rounded-md"
          :class="index % 3 === 0 ? 'w-2/3' : 'w-full'"
        />
      </div>
    </div>
  </div>
</template>
