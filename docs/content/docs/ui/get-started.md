---
title: Build your first UI view
description: "Install ViteHub UI, render a local question and reply with the Chat component in a Nuxt application, and check the result."
layout: tutorial
navigation.title: Get started
navigation.order: 2
navigation.group: Start
icon: i-lucide-rocket
---

You show a short chat on a page: one question and one reply. The messages are fixed in the code, so you can check the UI before you connect an Agent.

You need:

- Node.js 22.22 or newer
- pnpm
- a Nuxt app. Run every command from its root folder. For Vue with Vite, follow [Installation](/docs/ui/installation) first.

You do not need an AI provider, an API key, or a server route.

::tutorial-step{title="Install"}
## Install

Install the UI package and the packages that it needs:

```bash [commands/install]
pnpm add @vite-hub/ui @nuxt/ui ai tailwindcss vue @iconify-json/lucide @iconify-json/ph
```

- `@vite-hub/ui` gives you the `Chat` component.
- `@nuxt/ui` and `tailwindcss` give the components their style.
- `ai` is the AI SDK. It defines the type of a chat message.
- `@iconify-json/lucide` and `@iconify-json/ph` are the icon sets that the components use.

Add the module to `nuxt.config.ts`. Keep the modules that your app already has.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@vite-hub/ui/nuxt"],
});
```

The module loads the styles and makes the components available in every page. You do not need to import them or register a Vue plugin.

::

::tutorial-step{title="Show two messages"}
## Show two messages

Create `app.vue` with one question from the user and one reply from the assistant:

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

- `id` identifies each message.
- `role` tells `Chat` who wrote the message: `user` or `assistant`.
- `parts` holds the content. Here each message has one text part.
- `class="h-[32rem]"` gives the chat a fixed height. Long chats scroll inside it.

`Chat` only shows messages. It does not send requests or load data. Your app does that.

::

::tutorial-step{title="Open the page"}
## Open the page

Start the dev server:

```bash [commands/dev]
pnpm nuxt dev
```

Open the local URL that Nuxt prints. You see the question and then the reply. This proves that the module and `Chat` work in your app.

Change a text in `messages` and save the file. The page updates. Add more messages to see the chat scroll inside its fixed height.

::

::tutorial-step{title="Connect a chat endpoint"}
## Connect a chat endpoint

To send messages, your app needs a chat endpoint, a server route that returns the reply. When you have one, install the AI SDK for Vue:

```bash [commands/install-ai-sdk]
pnpm add @ai-sdk/vue
```

Create a composable that wraps `useChat()`:

```ts [src/composables/use-chat.ts]
import { useChat } from "@ai-sdk/vue";

export function useAppChat() {
  return useChat();
}
```

Set `useChat()` to use your endpoint. Call `useAppChat()` in `<script setup>`, and give the values that it returns to [`Chat`](/docs/ui/chat). Put [`PromptInput`](/docs/ui/prompt-input) in the `composer` slot of `Chat`, so the user can type a message.

::

## Next steps

- [Chat](/docs/ui/chat): see all the props and slots of `Chat`.
- [Chat App block](/docs/ui/blocks/chat-app): build a full chat with more than one session and file attachments.
- [Installation](/docs/ui/installation): use the components in a Vue and Vite app.
