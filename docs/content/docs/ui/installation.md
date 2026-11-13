---
title: Installation
description: "Install ViteHub UI in a Nuxt or Vue with Vite application, set the theme, and verify the setup with server rendering."
seo.title: Install ViteHub UI
navigation.title: Installation
navigation.order: 3
navigation.group: Start
icon: i-lucide-package
---

Add `@vite-hub/ui` to a Nuxt or Vue app, then render a short Markdown message
to check it works. You need Node.js 22.22 or newer.

The package is pre-1.0. Pin its version and read the changes before you upgrade.

## Dependencies

| Package                                   | Required for                                              |
| ----------------------------------------- | --------------------------------------------------------- |
| `vue`                                     | All entry points.                                         |
| `ai`                                      | All entry points. Components use AI SDK types. |
| `@ai-sdk/vue`                              | `useChat()` and other Vue helpers. Optional when the app has its own state. |
| `@nuxt/ui` and `tailwindcss`              | Styled components. Not needed for `@vite-hub/ui/headless`. |
| `vite` and `@vitejs/plugin-vue`           | The `@vite-hub/ui/vite` plugin.                           |
| `vite-hub`                                | Nuxt. `vite-hub/nuxt` gives the components their Nuxt runtime. |
| `@iconify-json/lucide`                    | Nuxt. `vite-hub/nuxt` adds the component icons to the `@nuxt/icon` client bundle. |

`@nuxt/ui` and `vite` are optional peers, so an app that uses only the headless entry does not need them.

## Install in Nuxt

Install the package and its peers:

```bash [commands/install-nuxt]
pnpm add vite-hub @vite-hub/ui @nuxt/ui ai tailwindcss vue @iconify-json/lucide
```

Add Nuxt UI and ViteHub to `nuxt.config.ts`. Register Nuxt UI first:

```ts [nuxt/nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@nuxt/ui", "vite-hub/nuxt"],
  css: ["~/assets/css/main.css"],
});
```

Load Tailwind CSS, Nuxt UI, and the package styles in this order:

```css [nuxt/assets/css/main.css]
@import "tailwindcss";
@import "@nuxt/ui";
@import "@vite-hub/ui/styles.css";
```

`vite-hub/nuxt` auto-imports every public component, for example `Chat`, `Markdown`, and `Trace`. It also gives them Nuxt UI's Nuxt icon and adds their icons to the `@nuxt/icon` client bundle. You do not register a Vue plugin. The stylesheet stays an explicit import, so you choose where it loads.

For explicit imports, import every component from `@vite-hub/ui`. A production build keeps only the components that the app uses. Only `MarkdownEditor` (`@vite-hub/ui/markdown-editor`) and the workspace parts (`@vite-hub/ui/workspace`) have their own entries, because their dependencies are large. The theme (`@vite-hub/ui/theme`) and the share links (`@vite-hub/ui/playground`) have their own too, because they load without the components.

## Install in Vue with Vite

Install the package, its peers, and Vite:

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

The Vite plugin does not register components. Import them where you use them:

```vue [vite/src/components/Example.vue]
<script setup lang="ts">
import { Chat } from "@vite-hub/ui";
</script>
```

These pages use Nuxt auto-imports. In Vue with Vite, import each component.

### Vite plugin options

| Option   | Type                            | Purpose                                                  |
| -------- | ------------------------------- | -------------------------------------------------------- |
| `nuxtUI` | `Record<string, unknown>`       | Options for the Nuxt UI Vite plugin.                     |
| `comark` | `false \| { prose?: boolean }`  | Options for the Comark plugin. Set `false` to remove it. |

## Verify the setup

In Nuxt, replace `app.vue` with this example. In Vue with Vite, put the
template in `App.vue` and import `Markdown` from `@vite-hub/ui`:

```vue [nuxt/app.vue]
<template>
  <Markdown value="**ViteHub UI is ready.**" />
</template>
```

Start your application and open it in the browser. You should see
**ViteHub UI is ready.** in bold. If the component is missing, check the Nuxt
modules or the Vue import. If it appears without styles, check the CSS imports.

Next, follow the [UI tutorial](/docs/ui/get-started) to show a chat message,
or pick a [Console block](/docs/ui/blocks/chat-app). Connecting a model or chat
endpoint is a separate step.

## Defaults

The package defaults are designed for a Console. Keep them until your product has a reason to change them. If you do need a package-wide override, set it in the Nuxt runtime config or pass it to `createViteHubUI()`.

```ts [nuxt/defaults/nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@nuxt/ui", "vite-hub/nuxt"],
  runtimeConfig: {
    public: {
      viteHubUI: {
        defaults: {
          markdown: { class: "vh-typeset vh-typeset-chat" },
          messageScroller: { edgeThreshold: 8, previousItemPeek: 64 },
        },
      },
    },
  },
});
```

```ts [vite/defaults/src/main.ts] fragment
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
| `markdown.class`                   | `vh-typeset vh-typeset-chat` | `Markdown`                        |
| `messageScroller.edgeThreshold`    | `8`                          | `Chat` when its prop is not set   |
| `messageScroller.previousItemPeek` | `64`                         | `Chat` when its prop is not set   |

Read the defaults in your components with `useViteHubUI()`.

## Nuxt UI components

The parts import the Nuxt UI components that they render, such as `UButton` and `UModal`, from `@nuxt/ui`. They do not look for them by name, so they work when the app registers Nuxt UI per template, as Nuxt does, or not at all. Icons are the exception in Nuxt: `vite-hub/nuxt` gives the parts Nuxt UI's Nuxt icon when the app installs `@vite-hub/ui`, which reads the `@nuxt/icon` client bundle.

To use other components, such as on a page without Nuxt UI, pass them by name:

```ts [vite/components/src/main.ts] fragment
app.use(createViteHubUI({ components: { UButton: MyButton, UIcon: MyIcon } }));
```

A part uses the component given here first, then a global one with the same name from `app.component()`, then Nuxt UI's.

Parts such as `CopyButton` read their icons from Nuxt UI's `appConfig.ui.icons`. The Nuxt module passes them for you. In Vue with Vite, pass the same icons, or each part falls back to Lucide:

```ts [vite/icons/src/main.ts] fragment
import { vitehubTheme } from "@vite-hub/ui/theme";

app.use(createViteHubUI({ icons: vitehubTheme.icons }));
```

## Theme

The stylesheet maps its CSS variables to Nuxt UI tokens. Override them on any element to change one view:

```css [vite/theme/src/assets/main.css]
.support-chat {
  --vh-ui-border: var(--ui-border-accented);
  --vh-ui-bg-elevated: var(--ui-bg-muted);
  --vh-ui-radius: 0.375rem;
}
```

The variables are `--vh-ui-radius`, `--vh-ui-border`, `--vh-ui-text`, `--vh-ui-muted`, `--vh-ui-dimmed`, `--vh-ui-highlighted`, `--vh-ui-inverted`, `--vh-ui-bg`, `--vh-ui-bg-muted`, `--vh-ui-bg-elevated`, `--vh-ui-bg-accented`, `--vh-ui-primary`, `--vh-ui-ring`, `--vh-ui-error`, `--vh-ui-info`, `--vh-ui-success`, and `--vh-ui-warning`. The stylesheet sets none of them. Unset, each follows its Nuxt UI token, such as `--ui-border`, where the part renders. So an element that sets Nuxt UI tokens, such as one with the `dark` class, themes the parts inside it.

`--vh-ui-radius` is the corner radius of framed parts, such as `CodeBlock` and `CodeView`. It defaults to Nuxt UI's `rounded-lg`, twice `--ui-radius`. Other corners, such as those of `Bubble` and `PromptInput`, derive from it, so one value changes them all.

## Server rendering

Chat output supports Vue server rendering. Scroll observers, clipboard actions, and attachment conversion use browser APIs and work after hydration.
