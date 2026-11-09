<script setup lang="ts">
// `::incorrect`: an example titled Incorrect, such as Markdown that a lint rule reports. `title` or the `#title` slot renames it.
import Example from "./Example.vue"

defineOptions({ inheritAttrs: false })
defineProps<{ title?: string }>()
</script>

<template>
  <Example v-bind="$attrs">
    <template #title>
      <UIcon name="i-lucide-circle-x" class="size-4" :style="{ color: 'var(--ui-error)' }" aria-hidden="true" />
      <slot name="title">{{ title ?? "Incorrect" }}</slot>
    </template>
    <slot />
  </Example>
</template>
