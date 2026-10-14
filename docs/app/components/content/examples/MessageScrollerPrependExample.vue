<script setup lang="ts">
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

const thread: ChatMessage[] = [
  { id: "message-1", role: "user", text: "Add a /health route to the API." },
  { id: "message-2", role: "assistant", text: "I added server/routes/health.ts. It returns { ok: true }." },
  { id: "message-3", role: "user", text: "Add a test for it." },
  { id: "message-4", role: "assistant", text: "I added test/health.test.ts. It expects status 200." },
  { id: "message-5", role: "user", text: "Run the tests." },
  { id: "message-6", role: "assistant", text: "pnpm test failed: Cannot find module 'h3' from server/routes/health.ts." },
  { id: "message-7", role: "user", text: "Why is h3 missing?" },
  { id: "message-8", role: "assistant", text: "h3 is a dependency of nitro, but the API package does not list it. I added h3 to package.json." },
  { id: "message-9", role: "user", text: "Run the tests again." },
  { id: "message-10", role: "assistant", text: "All 24 tests passed, including test/health.test.ts." },
];

const pageSize = 3;
const loaded = ref(4);
const messages = computed(() => thread.slice(thread.length - loaded.value));
const hasEarlier = computed(() => loaded.value < thread.length);

function loadEarlier() {
  loaded.value = Math.min(thread.length, loaded.value + pageSize);
}
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
    <UButton
      :label="hasEarlier ? 'Load earlier messages' : 'No earlier messages'"
      :disabled="!hasEarlier"
      icon="i-ph-clock-counter-clockwise-light"
      color="neutral"
      variant="outline"
      class="self-start"
      @click="loadEarlier"
    />
  </div>
</template>
