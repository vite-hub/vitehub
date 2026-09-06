<script setup lang="ts">
import {
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerRoot,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";

const messages = [
  { id: "message-1", text: "Inspect the current implementation." },
  { id: "message-2", text: "The virtual rows use a fixed height." },
  { id: "message-3", text: "Use cumulative offsets for described rows." },
  { id: "message-4", text: "The regression test now passes." },
];
</script>

<template>
  <MessageScrollerRoot class="relative h-72 overflow-hidden rounded-md border border-default bg-default">
    <MessageScrollerViewport class="h-full overflow-y-auto">
      <MessageScrollerContent :items="messages.map(message => message.id)" class="space-y-3 p-4">
        <MessageScrollerItem
          v-for="message in messages"
          :key="message.id"
          :message-id="message.id"
          class="rounded-md border border-default bg-elevated p-3 text-sm"
        >
          {{ message.text }}
        </MessageScrollerItem>
      </MessageScrollerContent>
    </MessageScrollerViewport>
    <MessageScrollerButton class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-default bg-default px-3 py-1 text-xs">
      Latest
    </MessageScrollerButton>
  </MessageScrollerRoot>
</template>
