<script setup lang="ts">
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";

type Role = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: Role;
  text: string;
}

const history: ChatMessage[] = [
  { id: "turn-0-user", role: "user", text: "Start the dev server." },
  {
    id: "turn-0-assistant",
    role: "assistant",
    text: "pnpm dev failed with EADDRINUSE. Another process uses port 3000.",
  },
];

const turns: [ChatMessage, ChatMessage][] = [
  [
    { id: "turn-1-user", role: "user", text: "Which process uses port 3000?" },
    {
      id: "turn-1-assistant",
      role: "assistant",
      text: "lsof -i :3000 shows node with PID 48121. It is an old pnpm dev session from another terminal.",
    },
  ],
  [
    { id: "turn-2-user", role: "user", text: "Stop it and start the server again." },
    {
      id: "turn-2-assistant",
      role: "assistant",
      text: "I stopped PID 48121 and ran pnpm dev. Vite is ready at http://localhost:3000.",
    },
  ],
  [
    { id: "turn-3-user", role: "user", text: "Can we use another port next time?" },
    {
      id: "turn-3-assistant",
      role: "assistant",
      text: "Yes. Set server.port in vite.config.ts, or run pnpm dev --port 3001.",
    },
  ],
];

const anchorRole = ref<Role>("user");
const messages = ref<ChatMessage[]>([...history]);
const nextTurn = ref(0);
const replying = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function send() {
  const turn = turns[nextTurn.value];
  if (!turn || replying.value) return;
  const [question, answer] = turn;
  nextTurn.value += 1;
  messages.value = [...messages.value, question];
  replying.value = true;
  timer = setTimeout(() => {
    messages.value = [...messages.value, answer];
    replying.value = false;
  }, 800);
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <div class="flex items-center gap-2 text-sm">
      <span class="text-muted">Anchor</span>
      <UButton
        v-for="role in ['user', 'assistant'] as const"
        :key="role"
        :label="role === 'user' ? 'User' : 'Assistant'"
        :variant="anchorRole === role ? 'solid' : 'outline'"
        :aria-pressed="anchorRole === role"
        color="neutral"
        size="xs"
        @click="anchorRole = role"
      />
    </div>
    <MessageScroller class="h-96 rounded-md border border-default">
      <MessageScrollerViewport>
        <!-- The bottom padding gives a new turn room to move near the top. -->
        <MessageScrollerContent :items="messages.map((message) => message.id)" class="p-4 pb-72">
          <MessageScrollerItem
            v-for="message in messages"
            :key="message.id"
            :message-id="message.id"
            :scroll-anchor="message.role === anchorRole"
          >
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
      :label="replying ? 'Replying' : 'Send next message'"
      :disabled="replying || nextTurn >= turns.length"
      icon="i-ph-paper-plane-right-light"
      color="neutral"
      variant="outline"
      class="self-start"
      @click="send"
    />
  </div>
</template>
