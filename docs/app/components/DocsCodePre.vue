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
  <div class="code-block-wrapper">
    <div v-if="filename" class="vh-code-filename">
      <span>{{ filename }}</span>
    </div>
    <pre
      :class="$props.class"
      :data-filename="filename || undefined"
      :data-code-filename="filename || undefined"
    ><slot /></pre>
  </div>
</template>

<style scoped>
.code-block-wrapper {
  min-width: 0;
  margin-block: 1rem;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
}

.vh-code-filename {
  display: flex;
  min-height: 2.5rem;
  align-items: center;
  gap: 0.5rem;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  padding: 0.375rem 0.75rem;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.25rem;
}

.vh-code-filename > span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.code-block-wrapper > pre {
  margin-block: 0;
}

.vh-code-filename + pre {
  border-start-start-radius: 0;
  border-start-end-radius: 0;
}
</style>
