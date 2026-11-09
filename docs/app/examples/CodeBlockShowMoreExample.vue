<script setup lang="ts">
import { useHighlightedCode } from "@vite-hub/ui";

// The closing script tag is escaped so the SFC parser does not end this block early.
const code = `<script setup lang="ts">
import { Chat } from "@ai-sdk/vue";
import { ref } from "vue";

const input = ref("");
const chat = new Chat({});

function send() {
  chat.sendMessage({ text: input.value });
  input.value = "";
}
<\/script>

<template>
  <div class="flex flex-col gap-4">
    <div v-for="message in chat.messages" :key="message.id">
      <template v-for="(part, index) in message.parts" :key="index">
        <p v-if="part.type === 'text'">{{ part.text }}</p>
      </template>
    </div>
    <form @submit.prevent="send">
      <UInput v-model="input" />
      <UButton type="submit" :disabled="chat.status !== 'ready'">Send</UButton>
    </form>
  </div>
</template>`;

const expanded = ref(false);
const lines = useHighlightedCode(code, "vue");
const id = useId();
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>app/components/ChatPanel.vue</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton :value="code" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent :id="id" line-numbers :class="expanded ? undefined : 'max-h-64 overflow-y-hidden'">
        <CodeBlockLine v-for="(line, index) in lines" :key="index">
          <component :is="line" />
        </CodeBlockLine>
      </CodeBlockContent>
      <CodeBlockFooter class="justify-center">
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          :icon="expanded ? 'i-ph-caret-up-light' : 'i-ph-caret-down-light'"
          :aria-expanded="expanded"
          :aria-controls="id"
          @click="expanded = !expanded"
        >
          {{ expanded ? "Show less" : "Show more" }}
        </UButton>
      </CodeBlockFooter>
    </CodeBlock>
  </div>
</template>
