<script setup lang="ts">
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";

const messages = [
  { id: "message-1", role: "user", text: "Why did the deploy fail?" },
  {
    id: "message-2",
    role: "assistant",
    text: "The build ran pnpm install --frozen-lockfile and stopped with ERR_PNPM_OUTDATED_LOCKFILE. The lockfile does not match package.json.",
  },
  { id: "message-3", role: "user", text: "Which dependency changed?" },
  {
    id: "message-4",
    role: "assistant",
    text: "package.json asks for vite ^8.1.0, but pnpm-lock.yaml still pins vite 8.0.4.",
  },
  { id: "message-5", role: "user", text: "Update the lockfile and run the tests." },
  {
    id: "message-6",
    role: "assistant",
    text: "I ran pnpm install and pnpm test. 128 tests passed. The lockfile change is ready to commit.",
  },
] as const;
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <MessageScroller class="h-80 rounded-md border border-default">
      <MessageScrollerViewport>
        <MessageScrollerContent :items="messages.map((message) => message.id)" class="p-4">
          <MessageScrollerItem v-for="message in messages" :key="message.id" :message-id="message.id">
            <Message :align="message.role === 'user' ? 'end' : 'start'">
              <MessageContent>
                <Bubble :variant="message.role === 'user' ? 'default' : 'secondary'">
                  <BubbleContent>{{ message.text }}</BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
          </MessageScrollerItem>
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton>
        <UIcon name="i-ph-arrow-down-light" />
      </MessageScrollerButton>
    </MessageScroller>
  </div>
</template>
