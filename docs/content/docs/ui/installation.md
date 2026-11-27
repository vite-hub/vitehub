---
title: Installation
description: "Install the AI components of ViteHub UI in a Nuxt or Vue with Vite application, set the theme, and verify the setup."
seo.title: Install the ViteHub UI AI components
navigation.title: Installation
navigation.order: 7
navigation.group: AI components
icon: i-lucide-package
---

Add `@vite-hub/ui` to a Nuxt or Vue app, then render a short Markdown message
to check it works. You need Node.js 24.15 or newer.

The package is pre-1.0. Pin its version and read the changes before you upgrade.

## Dependencies

| Package                                   | Required for                                              |
| ----------------------------------------- | --------------------------------------------------------- |
| `vue`                                     | All entry points.                                         |
| `ai`                                      | All entry points. Components use AI SDK types. |
| `@ai-sdk/vue`                              | `useChat()` and other Vue helpers. Optional when the app has its own state. |
| `tailwindcss`                             | Styled components. Not needed for `vite-hub/ui/headless`. |
| `@vite-hub/kit`                           | The styles of the ui-sdk components that the styled components render. Not needed when the app gives its own components. |
| `@nuxt/ui`                                | Nuxt only today: `vite-hub/nuxt` gives the components their Nuxt runtime in a Nuxt UI app. |
| `vite` and `@vitejs/plugin-vue`           | The `vite-hub/ui/vite` plugin.                           |
| `vite-hub`                                | All entry points: the `vite-hub/ui` paths. In Nuxt, `vite-hub/nuxt` gives the components their Nuxt runtime. |
| `@iconify-json/lucide`                    | Nuxt. `vite-hub/nuxt` adds the component icons to the `@nuxt/icon` client bundle. |

`vite` is an optional peer, so an app that uses only the headless entry does not need it. `@nuxt/ui` is not a peer of `vite-hub` or `@vite-hub/ui`.

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
@import "vite-hub/ui/styles.css";
```

`vite-hub/nuxt` auto-imports every public component, for example `Chat`, `Markdown`, and `Trace`. It also adds their icons to the `@nuxt/icon` client bundle. You do not register a Vue plugin. The stylesheet stays an explicit import, so you choose where it loads.

For explicit imports, import every component from `vite-hub/ui`. A production build keeps only the components that the app uses. Only `MarkdownEditor` (`vite-hub/ui/markdown-editor`) and the workspace parts (`vite-hub/ui/workspace`) have their own entries, because their dependencies are large. The theme (`vite-hub/ui/theme`) and the share links (`vite-hub/ui/playground`) have their own too, because they load without the components.

## Install in Vue with Vite

Install the package, its peers, and Vite:

```bash [commands/install-vite]
pnpm add vite-hub @vite-hub/ui @vite-hub/kit ai tailwindcss vue
pnpm add -D vite @vitejs/plugin-vue
```

Add the Vite plugin after the Vue plugin:

```ts [vite/vite.config.ts]
import vue from "@vitejs/plugin-vue";
import viteHubUI from "vite-hub/ui/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue(), ...viteHubUI()],
});
```

Register the ViteHub UI Vue plugin:

```ts [vite/src/main.ts]
import { createViteHubUI } from "vite-hub/ui";
import { createApp } from "vue";
import App from "./App.vue";
import "./assets/main.css";

createApp(App).use(createViteHubUI()).mount("#app");
```

Load Tailwind CSS, the kit styles, and the package styles in this order:

```css [vite/src/assets/main.css]
@layer theme, base, comark, ui-sdk, components, utilities;
@import "tailwindcss";
@import "@vite-hub/kit/styles/tokens.css";
@import "@vite-hub/kit/styles/default.css";
@import "vite-hub/ui/styles.css";
```

The Vite plugin does not register components. Import them where you use them:

```vue [vite/src/components/Example.vue]
<script setup lang="ts">
import { Chat } from "vite-hub/ui";
</script>
```

These pages use Nuxt auto-imports. In Vue with Vite, import each component.

### Vite plugin options

| Option   | Type                            | Purpose                                                  |
| -------- | ------------------------------- | -------------------------------------------------------- |
| `comark` | `false \| { prose?: boolean }`  | Options for the Comark plugin. Set `false` to remove it. |

## Verify the setup

In Nuxt, replace `app.vue` with this example. In Vue with Vite, put the
template in `App.vue` and import `Markdown` from `vite-hub/ui`:

```vue [nuxt/app.vue]
<template>
  <Markdown value="**ViteHub UI is ready.**" />
</template>
```

Start your application and open it in the browser. You should see
**ViteHub UI is ready.** in bold. If the component is missing, check the Nuxt
modules or the Vue import. If it appears without styles, check the CSS imports.

Next, follow the [chat tutorial](/docs/ui/chat-tutorial) to show a chat message,
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

The parts render a few components by name, such as `UButton`, `UModal`, and `UTooltip`. By default they render the ui-sdk ones, which the `@vite-hub/kit` styles draw. There is no ui-sdk `UTooltip`, so without one a part puts the text in the `title` attribute.

A part uses the component given to `createViteHubUI({ components })` first, then a global one with the same name from `app.component()`, then the ui-sdk one. To keep Nuxt UI's in Vue with Vite, pass them:

```ts [vite/components/src/main.ts] fragment
import UButton from "@nuxt/ui/components/Button.vue";
import UModal from "@nuxt/ui/components/Modal.vue";

app.use(createViteHubUI({ components: { UButton, UModal } }));
```

In Nuxt, register them as global components in a plugin:

```ts [nuxt/components/app/plugins/vitehub-ui.ts] fragment
import { UButton, UDropdownMenu, UIcon, UInput, UModal, UTabs, UTooltip } from "#components";

export default defineNuxtPlugin((nuxtApp) => {
  for (const [name, component] of Object.entries({ UButton, UDropdownMenu, UIcon, UInput, UModal, UTabs, UTooltip }))
    nuxtApp.vueApp.component(name, component);
});
```

Nuxt UI's `UTooltip` needs `UApp` around the page.

## Icons

The parts read their icons by name. A name that Nuxt UI has, such as `close` or `check`, comes from Nuxt UI's `appConfig.ui.icons`, so the parts follow the same icon set as Nuxt UI's own components. A name that Nuxt UI does not have, such as `edit` or `delete`, comes from `appConfig.viteHubUI.icons`. Each name falls back to Lucide.

```ts [nuxt/icons/app/app.config.ts]
export default defineAppConfig({
  ui: {
    icons: { check: "i-ph-check", close: "i-ph-x" },
  },
  viteHubUI: {
    icons: { delete: "i-ph-trash", edit: "i-ph-pencil-simple", reopen: "i-ph-arrow-counter-clockwise" },
  },
});
```

The Nuxt module reads both for you and follows changes to the app config. A name in `viteHubUI.icons` wins over the same name in `ui.icons`, for the ViteHub parts only. In Vue with Vite, pass one object with all the names. A ref or a getter keeps them reactive:

```ts [vite/icons/src/main.ts] fragment
import { vitehubTheme } from "vite-hub/ui/theme";

app.use(createViteHubUI({ icons: { ...vitehubTheme.icons, delete: "i-ph-trash", edit: "i-ph-pencil-simple" } }));
```

| Name | Source | Default | Used by |
| --- | --- | --- | --- |
| `arrowLeft` | Nuxt UI | `i-lucide-arrow-left` | Back button of `CommentThread` |
| `arrowUp` | Nuxt UI | `i-lucide-arrow-up` | Send button of `PromptInput` and `CommentComposer` |
| `check` | Nuxt UI | `i-lucide-check` | Resolve button of `CommentThread` |
| `chevronLeft` | Nuxt UI | `i-lucide-chevron-left` | Previous picture of a comment's image preview |
| `chevronRight` | Nuxt UI | `i-lucide-chevron-right` | Next picture of a comment's image preview |
| `close` | Nuxt UI | `i-lucide-x` | Close button of `CommentThread` and image previews, remove button of attachments |
| `copy` | Nuxt UI | `i-lucide-copy` | `CopyButton` before a copy |
| `copyCheck` | Nuxt UI | `i-lucide-check` | `CopyButton` after a copy |
| `external` | Nuxt UI | `i-lucide-external-link` | Open button of image previews |
| `file` | Nuxt UI | `i-lucide-file` | Attachments that are not images |
| `plus` | Nuxt UI | `i-lucide-plus` | Attach button of `PromptInput` and `CommentComposer` |
| `reload` | Nuxt UI | `i-lucide-refresh-cw` | Retry button of `PromptInput` |
| `stop` | Nuxt UI | `i-lucide-square` | Stop button of `PromptInput` |
| `comment` | ViteHub | `i-lucide-message-circle` | Comment mode button of `CommentToolbar` |
| `commentList` | ViteHub | `i-lucide-list` | List button of `CommentToolbar` |
| `commentPage` | ViteHub | `i-lucide-square-pen` | Page comment button of `CommentToolbar` |
| `delete` | ViteHub | `i-lucide-trash-2` | Delete button of a comment |
| `edit` | ViteHub | `i-lucide-pencil` | Edit button of a comment |
| `reopen` | ViteHub | `i-lucide-rotate-ccw` | Reopen button of a resolved `CommentThread` |

In Nuxt, Nuxt UI fills `appConfig.ui.icons` with its own defaults, so a Nuxt UI name shows Nuxt UI's icon, such as `i-lucide-arrow-up-right` for `external`. The Lucide default applies when nothing sets the name.

## Theme

The stylesheet maps its CSS variables to Nuxt UI tokens. Override them on any element to change one view:

```css [vite/theme/src/assets/main.css]
.support-chat {
  --vh-ui-border: var(--ui-border-accented);
  --vh-ui-bg-elevated: var(--ui-bg-muted);
  --vh-ui-radius: 0.375rem;
}
```

The variables are `--vh-ui-radius`, `--vh-ui-border`, `--vh-ui-border-accented`, `--vh-ui-text`, `--vh-ui-muted`, `--vh-ui-dimmed`, `--vh-ui-highlighted`, `--vh-ui-inverted`, `--vh-ui-bg`, `--vh-ui-bg-muted`, `--vh-ui-bg-elevated`, `--vh-ui-bg-accented`, `--vh-ui-primary`, `--vh-ui-ring`, `--vh-ui-error`, `--vh-ui-info`, `--vh-ui-success`, and `--vh-ui-warning`. The stylesheet sets none of them. Unset, each follows its Nuxt UI token, such as `--ui-border`, where the part renders. So an element that sets Nuxt UI tokens, such as one with the `dark` class, themes the parts inside it.

`--vh-ui-radius` is the corner radius of framed parts, such as `CodeBlock` and `CodeView`. It defaults to Nuxt UI's `rounded-lg`, twice `--ui-radius`. Other corners, such as those of `Bubble` and `PromptInput`, derive from it, so one value changes them all.

### Design system tokens

`vite-hub/ui/theme.css` is the ViteHub design system for a whole app. It sets the colors and the radius under their [shadcn/ui names](https://ui.shadcn.com/docs/theming), and Nuxt UI's `--ui-*` tokens read those names. To change one, set its name after the theme: on `:root` for light, and on `:root.dark` for dark.

```css [nuxt/tokens/assets/css/main.css]
@import "tailwindcss";
@import "@nuxt/ui";
@import "vite-hub/ui/theme.css";

:root {
  --radius: 0.375rem;
  --foreground: oklch(0.145 0 0);
}

:root.dark {
  --background: oklch(0.1 0 0);
}
```

| Name | Tokens that read it | Light | Dark |
| --- | --- | --- | --- |
| `--background` | `--ui-bg`, `--ui-text-inverted` | `oklch(1 0 0)` | `oklch(0.145 0 0)` |
| `--foreground` | `--ui-text-highlighted`, `--ui-bg-inverted`, `--ui-border-inverted` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` |
| `--muted` | `--ui-bg-elevated` | `oklch(0.97 0 0)` | `rgb(255 255 255 / 5%)` |
| `--muted-foreground` | `--ui-text-muted` | `oklch(0.5 0 0)` | `oklch(0.708 0 0)` |
| `--border` | `--ui-border` | `oklch(0.922 0 0)` | `rgb(255 255 255 / 10%)` |
| `--primary` | `--ui-primary` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` |
| `--popover` | `--vh-floating`, the surface of menus, popovers, and tooltips | `rgb(255 255 255 / 92%)` | `rgb(23 23 23 / 92%)` |
| `--ring` | `--vh-focus`, the focus ring and drawn comment areas | `oklch(0.588 0.158 241.966)` | `oklch(0.746 0.16 232.661)` |
| `--radius` | `--ui-radius` | `0.25rem` | `0.25rem` |

`--radius` is Nuxt UI's smallest step (`rounded-sm`), as in `@vite-hub/kit`. It is not the card radius of shadcn/ui. Nuxt UI multiplies it: buttons get 1.5 times, cards 2 times, and menus 3 times.

Do not load `@vite-hub/kit/styles/default.css` in an app with Nuxt UI. That style family is ui-sdk's `web.css`, which is only for apps without Nuxt UI. It styles plain `a`, `kbd`, and `button`, shares 8 `data-slot` names with Nuxt UI, and sets Nuxt UI's own `--ui-border`, `--ui-primary`, and `--ui-radius`, with `--ui-radius` as the whole radius. Loaded together, the two restyle each other.

The other Nuxt UI steps have no shadcn/ui name, so you set them on the token itself, in both blocks: `--ui-text`, `--ui-text-toned`, `--ui-text-dimmed`, `--ui-bg-muted`, `--ui-bg-accented`, `--ui-border-muted`, and `--ui-border-accented`. The status colors, such as `--ui-error`, come from the `colors` of the Nuxt UI app config. The theme also supplies `--primary-foreground`, `--input`, `--destructive`, `--overlay`, `--popover-foreground`, `--shadow-popover`, and `--shadow-dialog` for the scoped kit family. Its aliases read these names inside `.ui-sdk` without replacing Nuxt UI’s aliases. The theme does not set unused names such as `--card`.

## Server rendering

Chat output supports Vue server rendering. Scroll observers, clipboard actions, and attachment conversion use browser APIs and work after hydration.
