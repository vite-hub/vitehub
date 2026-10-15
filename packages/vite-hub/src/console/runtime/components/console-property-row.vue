<script setup lang="ts">
/**
 * One property row of a document, as in Notion: a compact label column with an icon, then the value. Values are ghost
 * controls that show a border on hover and focus. A required property without a value gets a dot after its label; an
 * invalid one gets its message under the value.
 */
defineProps<{
  description?: string;
  error?: string;
  /** Id of the control the label names. */
  control?: string;
  icon: string;
  label: string;
  /** Required and still empty. */
  missing?: boolean;
}>();
</script>

<template>
  <div class="grid min-h-8 grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] items-start gap-x-1 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
    <label
      :for="control"
      class="flex h-8 min-w-0 items-center gap-2 rounded-md px-1.5 text-[13px] text-muted"
      :class="error ? 'text-error' : ''"
      :title="description"
    >
      <UIcon :name="icon" class="size-4 shrink-0 opacity-70" aria-hidden="true" />
      <span class="truncate">{{ label }}</span>
      <span v-if="missing" class="size-1.5 shrink-0 rounded-full bg-error" aria-hidden="true" />
      <span v-if="missing" class="sr-only">(required)</span>
    </label>
    <div class="min-w-0">
      <slot />
      <p v-if="error" :id="control ? `${control}-error` : undefined" class="px-2.5 pt-0.5 pb-1.5 text-xs text-error">{{ error }}</p>
    </div>
  </div>
</template>
