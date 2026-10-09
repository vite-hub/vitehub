---
title: Installation
description: Add ViteHub UI to a Nuxt or Vue application.
navigation.title: Installation
navigation.order: 3
navigation.group: Start
icon: i-lucide-package
---

Add `@vite-hub/ui` to an existing Nuxt or Vue application and render a short
Markdown message to check that it works. Choose the setup for your framework,
then follow "Verify the setup" below. You need Node.js 24.15 or newer.

The package is pre-1.0. Pin its version and review changes before you upgrade.

## Dependencies

| Package                                   | Required for                                              |
| ----------------------------------------- | --------------------------------------------------------- |
| `vue`                                     | All entry points.                                         |
| `ai`                                      | All entry points. Components render AI SDK types.         |
| `@ai-sdk/vue`                              | `useChat()` and other Vue transport helpers. Optional when the app supplies its own state. |
| `@nuxt/ui` and `tailwindcss`              | Styled components. Not needed for `@vite-hub/ui/headless`. |
| `vite` and `@vitejs/plugin-vue`           | The `@vite-hub/ui/vite` plugin.                           |
| `@iconify-json/lucide`, `@iconify-json/ph` | The Nuxt module. It adds the component icons to the `@nuxt/icon` client bundle. |

`@nuxt/ui` and `vite` are optional peers, so an application that only uses the headless entry point does not install them.

## Install in Nuxt

Install the package and its peers:

```bash [commands/install-nuxt]
pnpm add @vite-hub/ui @nuxt/ui ai tailwindcss vue @iconify-json/lucide @iconify-json/ph
```

Add the module to `nuxt.config.ts`:

```ts [nuxt/nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@vite-hub/ui/nuxt"],
});
```

The module installs Nuxt UI, loads `@vite-hub/ui/styles.css`, and auto-imports every public component, for example `AgentChat`, `AgentMarkdown`, and `AgentInvocation`. You do not register a Vue plugin.

For explicit imports, each public component also has a kebab-case entry such as `@vite-hub/ui/agent-chat`. These entries export the same component objects as `@vite-hub/ui` and keep the development import graph focused.

## Install in Vue with Vite

Install the package, its peers, and the Vite tooling:

```bash [commands/install-vite]
pnpm add @vite-hub/ui @nuxt/ui ai tailwindcss vue
pnpm add -D vite @vitejs/plugin-vue
```

Add the Vite plugin after the Vue plugin:

```ts [vite/vite.config.ts]
import vue from "@vitejs/plugin-vue";
import viteHubUI from "@vite-hub/ui/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue(), ...viteHubUI()],
});
```

Register the Nuxt UI and ViteHub UI Vue plugins:

```ts [vite/src/main.ts]
import NuxtUI from "@nuxt/ui/vue-plugin";
import { createViteHubUI } from "@vite-hub/ui";
import { createApp } from "vue";
import App from "./App.vue";
import "./assets/main.css";

createApp(App).use(NuxtUI).use(createViteHubUI()).mount("#app");
```

Load Tailwind CSS, Nuxt UI, and the package styles in this order:

```css [vite/src/assets/main.css]
@import "tailwindcss";
@import "@nuxt/ui";
@import "@vite-hub/ui/styles.css";
```

The Vite plugin does not register ViteHub UI components. Import them where you use them:

```vue [vite/src/components/Example.vue]
<script setup lang="ts">
import { AgentChat } from "@vite-hub/ui";
</script>
```

The examples in these pages use Nuxt auto-imports. In Vue with Vite, add the import for each component.

### Vite plugin options

| Option   | Type                            | Purpose                                                  |
| -------- | ------------------------------- | -------------------------------------------------------- |
| `nuxtUI` | `Record<string, unknown>`       | Options for the Nuxt UI Vite plugin.                     |
| `comark` | `false \| { prose?: boolean }`  | Options for the Comark plugin. Set `false` to remove it. |

## Verify the setup

In Nuxt, replace the contents of `app.vue` with this example. In Vue with
Vite, put the template in `App.vue` and import `AgentMarkdown` from
`@vite-hub/ui` in its script:

```vue [nuxt/app.vue]
<template>
  <AgentMarkdown value="**ViteHub UI is ready.**" />
</template>
```

Start your application and open it in the browser. You should see
**ViteHub UI is ready.** in bold. If the component is missing, check the Nuxt
module or the Vue import. If it appears without styles, check the CSS imports.

You can now follow the [UI tutorial](/docs/ui/get-started) to display a chat
message, or choose a [Console block](/docs/ui/blocks/chat-app). Connecting a
model or chat endpoint is a separate step in your application.

## Defaults

The package defaults are designed for a Console. Keep them until your product has a reason to change them. If you do need a package-wide override, use the same option in the Nuxt module or the Vite plugin.

```ts [nuxt/defaults/nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@vite-hub/ui/nuxt"],
  viteHubUI: {
    defaults: {
      markdown: { class: "vh-typeset vh-typeset-chat" },
      messageScroller: { edgeThreshold: 8, previousItemPeek: 64 },
    },
  },
});
```

```ts [vite/defaults/src/main.ts]
app.use(
  createViteHubUI({
    defaults: {
      markdown: { class: "vh-typeset vh-typeset-chat" },
      messageScroller: { edgeThreshold: 8, previousItemPeek: 64 },
    },
  }),
);
```

| Default                            | Initial value                | Used by                                |
| ---------------------------------- | ---------------------------- | -------------------------------------- |
| `markdown.class`                   | `vh-typeset vh-typeset-chat` | `AgentMarkdown`                        |
| `messageScroller.edgeThreshold`    | `8`                          | `AgentChat` when its prop is not set   |
| `messageScroller.previousItemPeek` | `64`                         | `AgentChat` when its prop is not set   |

Read the resolved defaults in your own components with `useViteHubUI()`.

## Theme

The stylesheet maps its CSS variables to Nuxt UI tokens. Override them on any element to change one view:

```css [vite/theme/src/assets/main.css]
.support-chat {
  --vh-ui-border: var(--ui-border-accented);
  --vh-ui-bg-elevated: var(--ui-bg-muted);
  --vh-ui-radius: 0.375rem;
}
```

The variables are `--vh-ui-radius`, `--vh-ui-border`, `--vh-ui-text`, `--vh-ui-muted`, `--vh-ui-dimmed`, `--vh-ui-bg`, `--vh-ui-bg-muted`, `--vh-ui-bg-elevated`, `--vh-ui-error`, `--vh-ui-info`, `--vh-ui-success`, and `--vh-ui-warning`.

## Server rendering

Chat and Invocation output support Vue server rendering. Scroll observers, clipboard actions, and attachment conversion use browser APIs. They become interactive after hydration.
