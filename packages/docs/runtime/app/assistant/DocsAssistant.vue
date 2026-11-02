<script setup lang="ts">
import { onMounted, ref, watch } from "vue"

import { defineShortcuts } from "#imports"

import { useDocsAssistant } from "../composables/useDocsAssistant"

const { agent, open, toggle } = useDocsAssistant()
// Mount the panel on first open and keep it, so closing it keeps the conversation.
const mounted = ref(open.value)
watch(open, (value) => {
  if (value) mounted.value = true
})

// `defineShortcuts` reads `meta` as Command on macOS and as Ctrl elsewhere. The attribute names the same key.
const shortcut = ref("Control+I")
onMounted(() => {
  if (/Macintosh;/.test(navigator.userAgent)) shortcut.value = "Meta+I"
})

// The shortcut also works in the composer, so it closes the panel that it opened.
defineShortcuts({ meta_i: { usingInput: true, handler: () => agent.value && toggle() } })
</script>

<template>
  <template v-if="agent">
    <!-- The same pill as the ViteHub page tools. It stays in the page, so closing the panel can return focus to it. -->
    <div class="vh-assistant-launcher" :class="{ 'is-open': open }">
      <UTooltip text="Ask the docs" :kbds="['meta', 'i']" :content="{ side: 'top', sideOffset: 8 }">
        <button
          id="docs-assistant-trigger"
          type="button"
          class="vh-assistant-launcher__button"
          aria-controls="docs-assistant"
          :aria-expanded="open"
          :aria-keyshortcuts="shortcut"
          @click="toggle()"
        >
          <UIcon name="i-lucide-message-circle" class="size-3.5" />
          Ask
        </button>
      </UTooltip>
    </div>
    <ClientOnly>
      <DocsAssistantPanel v-if="mounted" :agent="agent" />
    </ClientOnly>
  </template>
</template>

<style scoped>
.vh-assistant-launcher {
  position: fixed;
  z-index: 30;
  right: max(1rem, env(safe-area-inset-right));
  bottom: max(1rem, env(safe-area-inset-bottom));
  display: flex;
  padding: 4px;
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 12px;
  background: rgb(17 17 17 / 92%);
  box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
  color-scheme: dark;
}

/* The open panel has its own Close button. Hidden, the launcher leaves the tab order but keeps its place. */
.vh-assistant-launcher.is-open {
  visibility: hidden;
}

.vh-assistant-launcher__button {
  position: relative;
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border-radius: 8px;
  color: #d4d4d4;
  font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
  transition: background-color 150ms ease-out, color 150ms ease-out;
}

@media (hover: hover) {
  .vh-assistant-launcher__button:hover {
    background: rgb(255 255 255 / 8%);
    color: #fafafa;
  }
}

.vh-assistant-launcher__button:focus-visible {
  outline: 2px solid #fafafa;
  outline-offset: 1px;
}

/* A 44px target on touch screens. The pill keeps its size. */
@media (pointer: coarse) {
  .vh-assistant-launcher__button::before {
    position: absolute;
    inset: -8px;
    content: "";
  }
}
</style>
