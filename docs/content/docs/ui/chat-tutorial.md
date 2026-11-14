---
title: Build your first chat view
description: "Install the AI components, render a local question and reply with the Chat component in a Nuxt application, and check the result."
layout: tutorial
navigation.title: Chat tutorial
navigation.order: 8
navigation.group: AI components
icon: i-lucide-rocket
---

ViteHub UI is a set of Vue components for AI apps, such as a chat view and a prompt box. The components show the data that you give them. Your app still loads and saves the messages.

In this tutorial, you show a short chat with one question and one reply. The messages are written in your code, so you can check the view before you connect an Agent.

> [!NOTE] Before you start
> You need Node.js 22.22 or newer, pnpm, and a Nuxt 5 app. Nuxt 5 is only in nightly builds for now: `pnpm add nuxt@npm:nuxt-nightly@5x`. Run the commands from the root of the app. You need no account and no API key. For Vue with Vite, follow [Installation](/docs/ui/installation) first.

::tutorial-step{title="Install and configure"}
## Install and configure

Install the UI package, ViteHub, and the packages that they need:

```bash pm [commands/install]
pnpm add vite-hub @vite-hub/ui @nuxt/ui ai tailwindcss vue @iconify-json/lucide
```

Add the modules to `nuxt.config.ts`. Keep the other modules of your app.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@nuxt/ui", "vite-hub/nuxt"],
  css: ["~/assets/css/main.css"],
});
```

Load Tailwind CSS, Nuxt UI, and the package styles in this order:

```css [assets/css/main.css]
@import "tailwindcss";
@import "@nuxt/ui";
@import "@vite-hub/ui/styles.css";
```

`vite-hub/nuxt` imports the components for you. You do not need to register a Vue plugin.
::

::tutorial-step{title="Render one message"}
## Render one message

Create `app.vue` with one user message and one assistant reply:

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
  <Chat :messages class="h-[32rem]" />
</template>
```

- Each message has an `id`, a `role`, and `parts`. Here each message has one text part.
- `role` tells `Chat` which message is the question (`user`) and which is the reply (`assistant`).
- `UIMessage` is the message type of the [AI SDK](https://ai-sdk.dev). `Chat` shows a list of them.
- `class="h-[32rem]"` gives the chat a fixed height. The messages scroll inside it.

This example sends no request. `Chat` does not load data or call an Agent.
::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start Nuxt:

```bash [commands/dev]
pnpm nuxt dev
```

Open the URL that Nuxt prints. The page shows the release question, then the reply. Change a text in `messages` and save the file. The view updates. Add more messages to see them scroll inside the chat.

To send messages, your app needs a chat endpoint, an API route that answers. When your endpoint is ready, install the AI SDK for Vue:

```bash pm [commands/install-ai-sdk]
pnpm add @ai-sdk/vue
```

```ts [composables/use-chat.ts]
import { useChat } from "@ai-sdk/vue";

export function useAppChat() {
  return useChat();
}
```

Then:

1. Configure `useChat()` for your endpoint.
2. Call `useAppChat()` in `<script setup>` of your component. Nuxt imports the files in `composables/` for you.
3. Pass the values that it returns to [`Chat`](/docs/ui/chat), such as `const { messages, status } = useAppChat()`.
4. Put [`PromptInput`](/docs/ui/prompt-input) in the `composer` slot of `Chat`, so users can type.

::

## Next steps

::card-group
:::card{title="Chat" icon="i-lucide-messages-square" to="/docs/ui/chat"}
See every prop and slot of the `Chat` component.
:::

:::card{title="Prompt input" icon="i-lucide-text-cursor-input" to="/docs/ui/prompt-input"}
Add the box where users type their message.
:::

:::card{title="Chat App block" icon="i-lucide-layout-panel-left" to="/docs/ui/blocks/chat-app"}
Build a full chat app with sessions and attachments.
:::
::
