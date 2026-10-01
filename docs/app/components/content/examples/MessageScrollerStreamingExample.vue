<script setup lang="ts">
import {
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerRoot,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";
import { onBeforeUnmount, onMounted, ref } from "vue";

const messages = ref(
  Array.from({ length: 6 }, (_, index) => ({ id: `message-${index}`, text: `Log line ${index + 1}` })),
);
let interval: ReturnType<typeof setInterval> | undefined;

// Append a line every second. Scroll up to stop following; the button returns to the live edge.
onMounted(() => {
  interval = setInterval(() => {
    const index = messages.value.length;
    messages.value = [...messages.value, { id: `message-${index}`, text: `Log line ${index + 1}` }];
    if (index >= 40) clearInterval(interval);
  }, 1000);
});

onBeforeUnmount(() => clearInterval(interval));
</script>

<template>
  <MessageScrollerRoot class="relative h-72 overflow-hidden rounded-md border border-default bg-default">
    <MessageScrollerViewport class="h-full overflow-y-auto" aria-label="Build log">
      <MessageScrollerContent :items="messages.map((message) => message.id)" class="space-y-1 p-3 font-mono text-xs">
        <MessageScrollerItem v-for="message in messages" :key="message.id" :message-id="message.id">
          {{ message.text }}
        </MessageScrollerItem>
      </MessageScrollerContent>
    </MessageScrollerViewport>
    <MessageScrollerButton
      class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-default bg-default px-3 py-1 text-xs"
    >
      Follow output
    </MessageScrollerButton>
  </MessageScrollerRoot>
</template>
