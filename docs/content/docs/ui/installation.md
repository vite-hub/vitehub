---
title: Installation
description: Add ViteHub UI to a Nuxt or Vue application.
navigation.order: 2
navigation.group: Start
icon: i-lucide-package
---

## Nuxt

Install the package and its public peers:

```bash
pnpm add @vite-hub/ui @nuxt/ui ai vue
```

Register the module. It installs Nuxt UI, registers ViteHub UI components, and includes the package stylesheet.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@vite-hub/ui/nuxt"],
});
```

Components such as `AgentChat`, `AgentChatPrompt`, and `AgentInvocation` are auto-imported.

## Vue with Vite

Use the Vite integration together with the Vue plugin:

```ts [vite.config.ts]
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import viteHubUI from "@vite-hub/ui/vite";

export default defineConfig({
  plugins: [vue(), ...viteHubUI()],
});
```

```ts [src/main.ts]
import { createApp } from "vue";
import { createViteHubUI } from "@vite-hub/ui";
import "@vite-hub/ui/styles.css";
import App from "./App.vue";

createApp(App).use(createViteHubUI()).mount("#app");
```

The Vite integration configures Nuxt UI and Comark. Register imported ViteHub components locally or through your preferred component auto-import plugin.

## Defaults

Set package-wide behavior through the Vue plugin or Nuxt module options:

```ts
createViteHubUI({
  defaults: {
    markdown: { class: "vh-typeset vh-typeset-chat my-markdown" },
    messageScroller: { edgeThreshold: 12, previousItemPeek: 72 },
  },
});
```

CSS variables such as `--vh-ui-border`, `--vh-ui-bg-elevated`, and `--vh-ui-radius` fall back to Nuxt UI tokens and remain overridable by the application.
