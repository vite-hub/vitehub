---
title: Installation
description: Add ViteHub UI to a Nuxt or Vue application.
navigation.order: 2
navigation.group: Start
icon: i-lucide-package
---

`@vite-hub/ui` requires Node.js 24.15 or newer. The package is pre-1.0, so pin its version and review changes before you upgrade.

## Peer dependencies

| Package                                   | Required for                                              |
| ----------------------------------------- | --------------------------------------------------------- |
| `vue`                                     | All entry points.                                         |
| `ai`                                      | All entry points. Components render AI SDK types.         |
| `@nuxt/ui` and `tailwindcss`              | Styled components. Not needed for `@vite-hub/ui/headless`. |
| `vite` and `@vitejs/plugin-vue`           | The `@vite-hub/ui/vite` plugin.                           |
| `@iconify-json/lucide`, `@iconify-json/ph` | The Nuxt module. It adds the component icons to the `@nuxt/icon` client bundle. |

`@nuxt/ui` and `vite` are optional peers, so an application that only uses the headless entry point does not install them.

## Nuxt

Install the package and its peers:

```bash
pnpm add @vite-hub/ui @nuxt/ui ai tailwindcss vue @iconify-json/lucide @iconify-json/ph
```

Register the module:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@vite-hub/ui/nuxt"],
});
```

The module installs Nuxt UI, loads `@vite-hub/ui/styles.css`, and auto-imports every public component, for example `AgentChat`, `AgentMarkdown`, and `AgentInvocation`. You do not register a Vue plugin.

## Vue with Vite

Install the package, its peers, and the Vite tooling:

```bash
pnpm add @vite-hub/ui @nuxt/ui ai tailwindcss vue
pnpm add -D vite @vitejs/plugin-vue
```

Add the Vite plugin after the Vue plugin:

```ts [vite.config.ts]
import vue from "@vitejs/plugin-vue";
import viteHubUI from "@vite-hub/ui/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue(), ...viteHubUI()],
});
```

Register the Nuxt UI and ViteHub UI Vue plugins:

```ts [src/main.ts]
import NuxtUI from "@nuxt/ui/vue-plugin";
import { createViteHubUI } from "@vite-hub/ui";
import { createApp } from "vue";
import App from "./App.vue";
import "./assets/main.css";

createApp(App).use(NuxtUI).use(createViteHubUI()).mount("#app");
```

Load Tailwind CSS, Nuxt UI, and the package styles in this order:

```css [src/assets/main.css]
@import "tailwindcss";
@import "@nuxt/ui";
@import "@vite-hub/ui/styles.css";
```

The Vite plugin does not register ViteHub UI components. Import them where you use them:

```vue
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

Render one component:

```vue
<template>
  <AgentMarkdown value="**ViteHub UI is ready.**" />
</template>
```

The page shows **ViteHub UI is ready.** in bold. This proves that the component and the Markdown renderer load. It does not configure a model or a chat endpoint.

## Defaults

Set package-wide defaults in the Nuxt module options or in `createViteHubUI()`:

::tabs
  :::tabs-item{label="Nuxt" icon="i-simple-icons-nuxtdotjs"}
    ```ts [nuxt.config.ts]
    export default defineNuxtConfig({
      modules: ["@vite-hub/ui/nuxt"],
      viteHubUI: {
        defaults: {
          markdown: { class: "vh-typeset vh-typeset-chat my-markdown" },
          messageScroller: { edgeThreshold: 12, previousItemPeek: 72 },
        },
      },
    });
    ```
  :::
  :::tabs-item{label="Vue with Vite" icon="i-simple-icons-vite"}
    ```ts [src/main.ts]
    app.use(
      createViteHubUI({
        defaults: {
          markdown: { class: "vh-typeset vh-typeset-chat my-markdown" },
          messageScroller: { edgeThreshold: 12, previousItemPeek: 72 },
        },
      }),
    );
    ```
  :::
::

| Default                            | Initial value                | Used by                                |
| ---------------------------------- | ---------------------------- | -------------------------------------- |
| `markdown.class`                   | `vh-typeset vh-typeset-chat` | `AgentMarkdown`                        |
| `messageScroller.edgeThreshold`    | `8`                          | `AgentChat` when its prop is not set   |
| `messageScroller.previousItemPeek` | `64`                         | `AgentChat` when its prop is not set   |

Read the resolved defaults in your own components with `useViteHubUI()`.

## Theme

The stylesheet maps its CSS variables to Nuxt UI tokens. Override them on any element to change one view:

```css
.support-chat {
  --vh-ui-border: var(--ui-border-accented);
  --vh-ui-bg-elevated: var(--ui-bg-muted);
  --vh-ui-radius: 0.375rem;
}
```

The variables are `--vh-ui-radius`, `--vh-ui-border`, `--vh-ui-text`, `--vh-ui-muted`, `--vh-ui-dimmed`, `--vh-ui-bg`, `--vh-ui-bg-muted`, `--vh-ui-bg-elevated`, `--vh-ui-error`, `--vh-ui-info`, `--vh-ui-success`, and `--vh-ui-warning`.

## Server rendering

Chat and Invocation output support Vue server rendering. Scroll observers, clipboard actions, and attachment conversion use browser APIs. They become interactive after hydration.
