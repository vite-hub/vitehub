<script setup lang="ts">
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader } from "@vite-hub/ui";
import { computed, ref } from "vue";

import { useConsoleToast } from "../client/toast";

/** The config that an app needs before an `account` Console can link it, for Nuxt and for Vite. */
const snippets = {
  nuxt: { label: "Nuxt", file: "nuxt.config.ts", code: "export default defineNuxtConfig({\n  modules: ['vite-hub/nuxt'],\n  vitehub: {\n    console: true,\n  },\n})" },
  vite: { label: "Vite", file: "vite.config.ts", code: "import { defineConfig } from 'vite'\nimport { vitehub } from 'vite-hub'\n\nexport default defineConfig({\n  plugins: [vitehub({\n    console: true,\n  })],\n})" },
} as const;
type Framework = keyof typeof snippets;

const toast = useConsoleToast();
const framework = ref<Framework>("nuxt");
const snippet = computed(() => snippets[framework.value]);
const tabs = Object.entries(snippets).map(([value, item]) => ({ label: item.label, value }));
</script>

<template>
  <!-- Both files sit in one grid cell, so the block keeps the height of the longer one when the tab changes. -->
  <CodeBlock size="sm" class="vitehub-account-snippet">
    <CodeBlockHeader class="vitehub-account-snippet__header">
      <UTabs
        v-model="framework"
        :items="tabs"
        :content="false"
        variant="link"
        size="xs"
        aria-label="Framework"
        :ui="{ list: 'border-b-0 p-0', trigger: 'px-2 py-2.5' }"
      />
      <CodeBlockActions>
        <span class="font-mono text-xs text-muted">{{ snippet.file }}</span>
        <CodeBlockCopyButton
          :value="snippet.code"
          :aria-label="`Copy ${snippet.file}`"
          color="neutral"
          @error="toast.show({ title: 'The browser blocked the clipboard. Select the code and copy it.' })"
        />
      </CodeBlockActions>
    </CodeBlockHeader>
    <CodeBlockContent
      v-for="(item, key) in snippets"
      :key="key"
      class="vitehub-account-snippet__code"
      :data-active="framework === key ? '' : undefined"
      :inert="framework !== key"
    >{{ item.code }}</CodeBlockContent>
  </CodeBlock>
</template>

<style>
.vitehub-account-snippet[data-slot="code-block"] {
  display: grid;
  grid-template-rows: auto 1fr;
}

.vitehub-account-snippet > * {
  grid-column: 1;
}

.vitehub-account-snippet__header[data-slot="code-block-header"] {
  border-bottom: 1px solid var(--ui-border);
  padding-block: 0;
  padding-inline-start: 0.25rem;
}

/* A short cross-fade, so the change of file reads as one block that changes, not as a jump. */
.vitehub-account-snippet__code[data-slot="code-block-content"] {
  grid-row: 2;
  opacity: 0;
  padding-top: 0.625rem;
  transition: opacity 150ms ease-out, visibility 0s linear 150ms;
  visibility: hidden;
}

.vitehub-account-snippet__code[data-active] {
  opacity: 1;
  transition: opacity 150ms ease-out;
  visibility: visible;
}

@media (prefers-reduced-motion: reduce) {
  .vitehub-account-snippet__code[data-slot="code-block-content"] {
    transition: none;
  }
}
</style>
