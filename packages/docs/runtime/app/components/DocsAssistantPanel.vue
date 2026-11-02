<script setup lang="ts">
import { computed, ref } from "vue"

import { useAgent, useChat, useRoute } from "#imports"

import { docsAssistantProblem } from "../composables/docs-assistant-problem"

const props = defineProps<{ agent: string }>()
const emit = defineEmits<{ close: [] }>()

const route = useRoute()
const chat = useChat(useAgent(props.agent))
const draft = ref("")
const problem = computed(() => chat.error.value ? docsAssistantProblem(chat.error.value, window.location.origin) : undefined)
// The server reads the page path from the request body and adds it to the Agent instructions.
const requestBody = () => ({ body: { page: route.path } })

function submit({ text }: { text: string }) {
  if (!text.trim()) return
  draft.value = ""
  void chat.sendMessage({ text }, requestBody())
}

function restart() {
  void chat.stop()
  chat.messages.value = []
  chat.clearError()
}
</script>

<template>
  <section
    aria-label="Docs assistant"
    class="fixed inset-x-2 bottom-2 z-40 flex h-[min(36rem,calc(100dvh-1rem))] flex-col border border-default bg-default sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[26rem]"
  >
    <header class="flex h-10 shrink-0 items-center gap-1 border-b border-default px-3">
      <h2 class="flex-1 text-sm font-medium text-highlighted">
        Ask the docs
      </h2>
      <UButton
        icon="i-lucide-rotate-ccw"
        color="neutral"
        variant="ghost"
        size="xs"
        aria-label="New conversation"
        :disabled="!chat.messages.value.length"
        @click="restart"
      />
      <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" aria-label="Close" @click="emit('close')" />
    </header>
    <Chat v-if="chat.messages.value.length" :messages="chat.messages.value" :status="chat.status.value" class="min-h-0 flex-1" />
    <p v-else class="flex-1 px-3 py-3 text-sm text-muted">
      Answers come from these docs, with links to the pages they use.
    </p>
    <div v-if="problem" role="alert" class="shrink-0 border-t border-default px-3 py-2 text-sm" :data-code="problem.code">
      <p class="font-medium text-highlighted">
        {{ problem.title }}
      </p>
      <p class="text-muted">
        {{ problem.detail }}
      </p>
      <pre v-if="problem.command" class="mt-1 whitespace-pre-wrap break-all bg-elevated px-2 py-1 font-mono text-xs text-highlighted"><code>{{ problem.command }}</code></pre>
    </div>
    <PromptInput
      v-model="draft"
      class="shrink-0 border-t border-default p-2"
      placeholder="Ask a question"
      :attachments="false"
      :status="chat.status.value"
      @submit="submit"
      @stop="chat.stop()"
      @reload="chat.regenerate(requestBody())"
    />
  </section>
</template>
