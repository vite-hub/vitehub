<script setup lang="ts">
import { computed, ref } from "vue";

/** The config that an app needs before an `account` Console can link it, for Nuxt and for Vite. */
const snippets = {
  nuxt: { label: "Nuxt", file: "nuxt.config.ts", code: "export default defineNuxtConfig({\n  modules: ['vite-hub/nuxt'],\n  vitehub: {\n    console: { auth: 'token' },\n  },\n})" },
  vite: { label: "Vite", file: "vite.config.ts", code: "import { defineConfig } from 'vite'\nimport { vitehub } from 'vite-hub'\n\nexport default defineConfig({\n  plugins: [vitehub({\n    console: { auth: 'token' },\n  })],\n})" },
} as const;

const framework = ref<keyof typeof snippets>("nuxt");
const snippet = computed(() => snippets[framework.value]);
const copyState = ref<"copied" | "failed">();

async function copy(): Promise<void> {
  copyState.value = await navigator.clipboard.writeText(snippet.value.code).then(() => "copied" as const, () => "failed" as const);
  setTimeout(() => { copyState.value = undefined; }, 3000);
}
</script>

<template>
  <div class="vitehub-account-snippet">
    <div class="flex items-center gap-1 border-b border-default ps-1 pe-1">
      <div role="group" aria-label="Framework" class="flex flex-1 gap-1">
        <button
          v-for="(item, key) in snippets"
          :key="key"
          type="button"
          class="vitehub-account-snippet__tab"
          :aria-pressed="framework === key"
          @click="framework = key"
        >
          {{ item.label }}
        </button>
      </div>
      <span class="font-mono text-xs text-muted">{{ snippet.file }}</span>
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        :icon="copyState === 'copied' ? 'i-lucide-check' : 'i-lucide-copy'"
        :aria-label="`Copy ${snippet.file}`"
        @click="copy"
      />
      <span role="status" class="sr-only">{{ copyState === "copied" ? "Copied" : copyState === "failed" ? "The browser blocked the clipboard" : "" }}</span>
    </div>
    <pre class="overflow-x-auto p-3 font-mono text-xs leading-5 text-default">{{ snippet.code }}</pre>
  </div>
</template>

<style>
.vitehub-account-snippet {
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  min-width: 0;
}

.vitehub-account-snippet__tab {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 500;
  margin-bottom: -1px;
  padding: 0.5rem 0.5rem 0.4375rem;
  border-bottom: 1px solid transparent;
}

.vitehub-account-snippet__tab:hover {
  color: var(--ui-text);
}

.vitehub-account-snippet__tab[aria-pressed="true"] {
  border-bottom-color: var(--ui-text-highlighted);
  color: var(--ui-text-highlighted);
}

.vitehub-account-snippet__tab:focus-visible {
  outline: 2px solid var(--vitehub-console-focus);
  outline-offset: -2px;
}
</style>
