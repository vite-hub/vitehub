<script setup lang="ts">
// `::correct`: an example titled Correct, such as Markdown that a lint rule accepts. `title` or the `#title` slot renames it.
import Example from "./Example.vue"

defineOptions({ inheritAttrs: false })
defineProps<{ title?: string }>()
</script>

<template>
  <Example v-bind="$attrs">
    <template #title>
      <UIcon name="i-lucide-circle-check" class="size-4" :style="{ color: 'var(--ui-success)' }" aria-hidden="true" />
      <slot name="title">{{ title ?? "Correct" }}</slot>
    </template>
    <slot />
  </Example>
</template>
