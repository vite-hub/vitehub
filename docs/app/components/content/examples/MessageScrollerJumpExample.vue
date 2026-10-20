<script setup lang="ts">
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";

const messages = [
  { id: "lint-user", role: "user", text: "Run pnpm lint." },
  { id: "lint-assistant", role: "assistant", text: "pnpm lint found 3 problems in src/server/session.ts: two unused imports and one no-explicit-any." },
  { id: "fix-user", role: "user", text: "Fix them." },
  { id: "fix-assistant", role: "assistant", text: "I removed the unused imports and typed the session payload as SessionPayload. pnpm lint now passes." },
  { id: "test-user", role: "user", text: "Run the tests too." },
  { id: "test-assistant", role: "assistant", text: "pnpm test passed. 128 tests in 3 files." },
  { id: "commit-user", role: "user", text: "Commit the change." },
  { id: "commit-assistant", role: "assistant", text: "I committed fix(server): type the session payload on branch fix/session-types." },
] as const;

const turns = [
  { id: "lint-user", label: "Lint" },
  { id: "fix-user", label: "Fix" },
  { id: "test-user", label: "Test" },
  { id: "commit-user", label: "Commit" },
];
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <MessageScroller v-slot="{ scrollToMessage }" class="h-80 rounded-md border border-default">
      <nav aria-label="Turns" class="flex gap-1 border-b border-default p-2">
        <UButton
          v-for="turn in turns"
          :key="turn.id"
          :label="turn.label"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="scrollToMessage(turn.id, { block: 'nearest' })"
        />
      </nav>
      <MessageScrollerViewport class="min-h-0 flex-1">
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
