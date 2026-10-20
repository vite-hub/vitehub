<script setup lang="ts">
defineProps<{
  code?: string;
  language?: string | null;
  filename?: string | null;
  highlights?: number[];
  meta?: string | null;
  class?: string | null;
}>();
</script>

<template>
  <pre
    :class="$props.class"
    :data-filename="filename || undefined"
    :data-code-filename="filename || undefined"
  ><slot /></pre>
</template>
