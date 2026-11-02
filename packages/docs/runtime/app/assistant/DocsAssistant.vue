<script setup lang="ts">
import { ref, watch } from "vue"

import { defineShortcuts } from "#imports"

import { useDocsAssistant } from "../composables/useDocsAssistant"

const { agent, open, toggle } = useDocsAssistant()
// Mount the panel on first open and keep it, so closing it keeps the conversation.
const mounted = ref(open.value)
watch(open, (value) => {
  if (value) mounted.value = true
})

defineShortcuts({ meta_i: () => agent.value && toggle() })
</script>

<template>
  <template v-if="agent">
    <UButton
      v-if="!open"
      label="Ask"
      icon="i-lucide-message-circle"
      color="neutral"
      variant="outline"
      size="sm"
      class="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 rounded-none bg-default"
      aria-keyshortcuts="Meta+I"
      @click="toggle(true)"
    >
      <template #trailing>
        <span class="hidden items-center gap-0.5 sm:flex">
          <UKbd value="meta" size="sm" />
          <UKbd value="I" size="sm" />
        </span>
      </template>
    </UButton>
    <ClientOnly>
      <DocsAssistantPanel v-if="mounted" v-show="open" :agent="agent" @close="toggle(false)" />
    </ClientOnly>
  </template>
</template>
