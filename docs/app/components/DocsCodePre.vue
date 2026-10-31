<script setup lang="ts">
import { useClipboard } from "@vueuse/core";

const props = defineProps<{
  code?: string;
  language?: string | null;
  filename?: string | null;
  highlights?: number[];
  meta?: string | null;
  class?: string | null;
}>();

const pre = useTemplateRef<HTMLPreElement>("pre");
const { copy, copied } = useClipboard({ copiedDuring: 1500 });

function copyCode() {
  copy(props.code ?? pre.value?.textContent ?? "");
}
</script>

<template>
  <div class="code-block-wrapper" :class="{ 'has-filename': filename }">
    <div v-if="filename" class="vh-code-filename">
      <span>{{ filename }}</span>
    </div>
    <pre
      ref="pre"
      :class="$props.class"
      :data-filename="filename || undefined"
      :data-code-filename="filename || undefined"
    ><slot /></pre>
    <!-- After the filename bar, so the tutorial code panel still finds the bar as the first child. -->
    <UButton
      :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-label="copied ? 'Copied' : 'Copy code'"
      class="vh-code-copy"
      @click="copyCode"
    />
  </div>
</template>

<style scoped>
.code-block-wrapper {
  position: relative;
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
  /* The copy button sits over the end of the bar, so a long name wraps before it. */
  padding: 0.375rem 2.75rem 0.375rem 0.75rem;
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

/* Centered in the 40px filename bar, or in the first line of code when there is no bar. */
.vh-code-copy {
  position: absolute;
  top: 0.4375rem;
  right: 0.4375rem;
  color: var(--ui-text-muted);
}

.code-block-wrapper:not(.has-filename) > .vh-code-copy {
  top: 0.5625rem;
  background: var(--ui-bg);
}

/* With a mouse the button shows on hover or focus. Touch screens cannot hover, so it stays visible there. */
@media (hover: hover) and (pointer: fine) {
  .vh-code-copy {
    opacity: 0;
    transition: opacity 150ms ease;
  }

  .code-block-wrapper:hover > .vh-code-copy,
  .vh-code-copy:focus-visible {
    opacity: 1;
  }
}

@media (pointer: coarse) {
  .vh-code-copy {
    top: 0.125rem;
    right: 0.125rem;
    width: 2.25rem;
    height: 2.25rem;
    justify-content: center;
  }

  .code-block-wrapper:not(.has-filename) > .vh-code-copy {
    top: 0.25rem;
    right: 0.25rem;
  }
}
</style>
