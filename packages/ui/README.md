# @vite-hub/ui

Vue primitives for AI chat, Agent Invocations, traces, diffs, and file trees. The styled components compose [Nuxt UI](https://ui.nuxt.com/) and render [AI SDK](https://ai-sdk.dev/) message contracts; the headless entry point provides message-scrolling behavior without the styled component layer.

## Choose an entry point

| Import                  | Use it for                                                                                | Application responsibility                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@vite-hub/ui`          | Styled chat, prompt, Markdown, session, invocation, trace, diff, and file-tree components | State, transport, persistence, routes, and authorization                                       |
| `@vite-hub/ui/headless` | Message viewport, live-edge following, prepend preservation, and message jumps            | Markup and styles; Nuxt UI is not required                                                     |
| `@vite-hub/ui/nuxt`     | Nuxt module setup                                                                         | Installs the Nuxt UI module, registers ViteHub UI components, and loads the package stylesheet |
| `@vite-hub/ui/vite`     | Vue with Vite setup                                                                       | Configures the Nuxt UI and Comark Vite plugins                                                 |

The package currently declares `vue` and `ai` as required peers. Styled components also require `@nuxt/ui` and Tailwind CSS. The Vite integration requires `vite`; `@nuxt/ui` and `vite` are optional peers only so applications using another entry point do not have to install them.

## Nuxt

Add the package and its runtime peers to an existing Nuxt application:

```bash
pnpm add @vite-hub/ui @nuxt/ui ai tailwindcss vue
```

Register the module:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@vite-hub/ui/nuxt"],
});
```

The module installs Nuxt UI, includes `@vite-hub/ui/styles.css`, and auto-imports public components such as `AgentChat`, `AgentMarkdown`, and `AgentInvocation`. No separate Vue plugin registration is needed.

## Vue with Vite

Add the runtime peers to an existing Vue and Vite application:

```bash
pnpm add @vite-hub/ui @nuxt/ui ai tailwindcss vue
pnpm add -D vite @vitejs/plugin-vue
```

Compose the Vite integrations:

```ts
// vite.config.ts
import vue from "@vitejs/plugin-vue";
import viteHubUI from "@vite-hub/ui/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue(), ...viteHubUI()],
});
```

Register the Nuxt UI and ViteHub UI Vue plugins:

```ts
// src/main.ts
import NuxtUI from "@nuxt/ui/vue-plugin";
import { createViteHubUI } from "@vite-hub/ui";
import { createApp } from "vue";
import App from "./App.vue";
import "./assets/main.css";

createApp(App).use(NuxtUI).use(createViteHubUI()).mount("#app");
```

Load Tailwind, Nuxt UI, and the package styles in that order:

```css
/* src/assets/main.css */
@import "tailwindcss";
@import "@nuxt/ui";
@import "@vite-hub/ui/styles.css";
```

Unlike the Nuxt module, the Vite integration does not auto-register ViteHub UI components. Import them from `@vite-hub/ui` in each component or use the application's component-registration convention.

## Verify the setup

Render a public component directly:

```vue
<script setup lang="ts">
import { AgentMarkdown } from "@vite-hub/ui";
</script>

<template>
  <AgentMarkdown value="**ViteHub UI is ready.**" />
</template>
```

The page displays **ViteHub UI is ready.** in bold. This confirms the public component import and Markdown renderer; it does not configure a model or chat endpoint.

## Boundaries and requirements

- Published builds require Node.js 24.15 or newer. The package is pre-1.0, so pin its version and review changes before upgrading.
- The components render state supplied by the application. They do not send messages, fetch Agent Invocations, choose routes, persist sessions, or authorize access to instruction and trace data.
- Primary chat and invocation output supports Vue server rendering. Scrolling observers, clipboard actions, and attachment conversion use browser APIs and become interactive after hydration. Upload and persist raw files yourself when data URLs are not appropriate.
- The styled components depend on Nuxt UI components and tokens. `@vite-hub/ui/styles.css` adds ViteHub presentation but is not a replacement for the Tailwind and Nuxt UI imports.
- The package supplies accessible defaults for its message log, prompt, scroll controls, lists, and built-in actions. The application remains responsible for accessible names on custom controls and slots, meaningful status and error copy, focus behavior around application-owned navigation, and testing the completed interface.
- The headless entry point owns scrolling behavior, not appearance. Importing `@vite-hub/ui/headless` does not load the stylesheet or register Nuxt UI components.

## Documentation

- [UI overview and layer ownership](https://vitehub.dev/docs/ui)
- [Installation and package defaults](https://vitehub.dev/docs/ui/installation)
- [Chat and transport boundary](https://vitehub.dev/docs/ui/chat)
- [Chat prompt](https://vitehub.dev/docs/ui/chat-prompt) and [attachments](https://vitehub.dev/docs/ui/attachments)
- [Headless message scroller](https://vitehub.dev/docs/ui/message-scroller)
- [Agent Invocation views](https://vitehub.dev/docs/ui/invocation)
- [Diff](https://vitehub.dev/docs/ui/diff) and [file-tree views](https://vitehub.dev/docs/ui/file-tree)
