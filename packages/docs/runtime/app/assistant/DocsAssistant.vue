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
        <UButton
          id="docs-assistant-trigger"
          icon="i-lucide-message-circle"
          label="Ask"
          variant="ghost"
          class="vh-assistant-launcher__button"
          aria-controls="docs-assistant"
          :aria-expanded="open"
          :aria-keyshortcuts="shortcut"
          @click="toggle()"
        />
      </UTooltip>
    </div>
    <ClientOnly>
      <DocsAssistantPanel v-if="mounted" :agent="agent" />
    </ClientOnly>
  </template>
</template>

<style scoped>
/* A floating pill: the floating surface and shadow of the theme, one radius step above the button inside it. */
.vh-assistant-launcher {
  position: fixed;
  z-index: 30;
  right: max(1rem, env(safe-area-inset-right));
  bottom: max(1rem, env(safe-area-inset-bottom));
  display: flex;
  padding: 0.25rem;
  border-radius: calc(var(--ui-radius) * 2.5);
  background: var(--vh-floating);
  box-shadow: var(--vh-shadow-floating);
  backdrop-filter: blur(12px);
}

/* The open panel has its own Close button. Hidden, the launcher leaves the tab order but keeps its place. */
.vh-assistant-launcher.is-open {
  visibility: hidden;
}

/* A 44px target on touch screens. The pill keeps its size. */
@media (pointer: coarse) {
  .vh-assistant-launcher__button {
    position: relative;
  }

  .vh-assistant-launcher__button::before {
    position: absolute;
    inset: -8px;
    content: "";
  }
}
</style>
