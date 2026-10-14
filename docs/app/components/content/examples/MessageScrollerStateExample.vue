<script setup lang="ts">
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";

const messages = [
  { id: "message-1", role: "user", text: "Check why CI is red on main." },
  { id: "message-2", role: "assistant", text: "The typecheck job failed. src/routes/upload.ts uses File, but tsconfig.json does not include the DOM lib." },
  { id: "message-3", role: "user", text: "Add the lib and rerun the job." },
  { id: "message-4", role: "assistant", text: "I added \"DOM\" to compilerOptions.lib. pnpm typecheck passes locally." },
  { id: "message-5", role: "user", text: "Did the rerun pass?" },
  { id: "message-6", role: "assistant", text: "Yes. Typecheck, lint, and test passed in 3m 12s." },
] as const;
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <MessageScroller
      v-slot="{ atEnd, isScrollable, scrollToEnd }"
      default-scroll-position="start"
      class="h-80 rounded-md border border-default"
    >
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
      <div class="flex items-center justify-between gap-2 border-t border-default p-2 text-xs text-muted">
        <span role="status">
          {{ !isScrollable ? "All messages fit" : atEnd ? "At the latest message" : "Reading earlier messages" }}
        </span>
        <UButton
          label="Jump to latest"
          icon="i-ph-arrow-down-light"
          :disabled="atEnd"
          color="neutral"
          variant="outline"
          size="xs"
          @click="scrollToEnd()"
        />
      </div>
    </MessageScroller>
  </div>
</template>
