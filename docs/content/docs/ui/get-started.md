---
title: Build your first UI view
description: Render a local question and reply with AgentChat in a Nuxt application.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
navigation.group: Start
icon: i-lucide-rocket
---

Render a short chat with one question and one reply. You will install the Nuxt module and pass an AI SDK message array to `AgentChat`. This first page uses local messages so you can check the UI before connecting an Agent.

You need Node.js 24.15 or newer, pnpm, and a Nuxt application. Run the commands from its root. For Vue with Vite, follow [Installation](/docs/ui/installation) first. The UI package renders your app's state; your app still owns fetching, routes, and message storage.

::tutorial-step{title="Install and configure"}
## Install and configure

Install the UI package and its Nuxt peers. Add the module to your existing Nuxt config, keeping the modules your app already uses.

```bash [commands/install]
pnpm add @vite-hub/ui @nuxt/ui ai tailwindcss vue @iconify-json/lucide @iconify-json/ph
```

Register the module in `nuxt.config.ts`:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@vite-hub/ui/nuxt"],
});
```

The module loads the package stylesheet and auto-imports the public UI
components. You do not need a Vue plugin registration in Nuxt.
::

::tutorial-step{title="Render one message"}
## Render one message

Create `app.vue` with one user message and one assistant reply:

Each message has an id, a role, and text parts. The roles tell `AgentChat` which message is the user's question and which is the reply. No request is sent by this example.

```vue [app.vue]
<script setup lang="ts">
import type { UIMessage } from "ai";

const messages: UIMessage[] = [
  {
    id: "welcome-user",
    role: "user",
    parts: [{ type: "text", text: "What should I check before a release?" }],
  },
  {
    id: "welcome-assistant",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Run the build and focused tests, then inspect the preview at the target viewport sizes.",
      },
    ],
  },
];
</script>

<template>
  <AgentChat :messages class="h-[32rem]" />
</template>
```

`AgentChat` renders the AI SDK `UIMessage[]` and keeps scrolling inside its
container. The component does not fetch data or choose an Agent route.
::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start Nuxt and open the page:

```bash [commands/dev]
pnpm nuxt dev
```

Open the local URL printed by Nuxt. The page should show the release question followed by the reply. Change either text in `messages` and save the file to check that the view updates. Add more messages to check scrolling inside the fixed-height chat.

You now have a working message view. To send messages, your app also needs a chat endpoint. Once that endpoint is ready, install the Vue AI SDK integration:

```bash [commands/install-ai-sdk]
pnpm add @ai-sdk/vue
```

```ts [src/composables/use-chat.ts]
import { useChat } from "@ai-sdk/vue";

export function useAppChat() {
  return useChat();
}
```

Configure `useChat()` for your endpoint, call `useAppChat()` in the component's `<script setup>`, and pass its returned values to [`AgentChat`](/docs/ui/chat). Place
[`AgentChatPrompt`](/docs/ui/chat-prompt) in its `composer` slot. The [Chat
App block](/docs/ui/blocks/chat-app) shows session switching and attachments.
::
