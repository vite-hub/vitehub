# @vite-hub/ui

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fui&icon=npm)](https://npmx.dev/package/@vite-hub/ui)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fui&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/ui)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

Vue primitives for AI chat, traces, diffs, and file trees. The styled components compose [Nuxt UI](https://ui.nuxt.com/) and render [AI SDK](https://ai-sdk.dev/) message contracts; the headless entry point provides message-scrolling behavior without the styled component layer.

`Markdown` accepts a string or a parsed Content page. Comark UI block components and document styles are bundled, so readers do not install Comark packages or assemble a component map. The Nuxt module auto-imports the primitive; Vite apps import it from `@vite-hub/ui/markdown`.

Markdown images and image attachments use compact thumbnails with an expanded preview. The preview preserves the full aspect ratio and supports Escape, focus return, and opening the original image. Prompt attachments have a separate Remove button.

## Choose an entry point

| Import                  | Use it for                                                                                | Application responsibility                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@vite-hub/ui`          | Styled chat, prompt, Markdown, session, trace, diff, and file-tree components | State, transport, persistence, routes, and authorization                                       |
| `@vite-hub/ui/chat` (and other component entries) | One component or part family, for example `Chat`, `PromptInput`, or the `Trace` parts | State, transport, persistence, routes, and authorization |
| `@vite-hub/ui/headless` | Message viewport, live-edge following, prepend preservation, message jumps, and `useComments()` | Markup and styles; Nuxt UI is not required                                                     |
| `@vite-hub/ui/nuxt`     | Nuxt module setup                                                                         | Installs the Nuxt UI module, registers ViteHub UI components, and loads the package stylesheet |
| `@vite-hub/ui/workspace` (and the other workspace entries) | A live app in the browser: editor, terminal, preview, boot checklist, and Connect | Files, tokens, and the cross-origin isolated route |
| `@vite-hub/ui/vite`     | Vue with Vite setup                                                                       | Configures the Nuxt UI and Comark Vite plugins                                                 |

`@vite-hub/ui/primitive-rail` holds the icon rail and `PrimitiveIcon`, which draws a [`@vite-hub/icons`](../icons/README.md) icon inline so its rail item can move it on hover. ViteHub docs and the Console share both. The Nuxt module registers the `vitehub` Iconify collection, so `i-vitehub-kv` also works in `UIcon`. It is internal: it can change in any release and the Nuxt module does not auto-import it. Its styles are in `@vite-hub/ui/styles.css`. The rail always takes 3.5rem of the layout and expands over the next element on hover or keyboard focus to show labels. Its slots receive `expanded`, so a consumer can turn off its tooltips while the labels show.

The parts `Message`, `Bubble`, `Marker`, `Trace`, and `Attachment` follow the [shadcn/ui agentic components](https://ui.shadcn.com/docs/changelog/2026-10-ai-elements): the same part names, props, and `data-slot` attributes. Each family has one entry, for example `@vite-hub/ui/trace` exports `Trace`, `TraceLine`, and the other Trace parts. Their default styles map shadcn/ui tokens to Nuxt UI tokens and live in the `components` layer of `styles.css`, so Tailwind utility classes on a part override them. Set the Nuxt module's `prefix` option, for example `viteHubUI: { prefix: "Vh" }`, when the application already has a `Message` or `Trace` component.

Component entries use kebab-case and export the same component object as the package root. Use them when a development import should stay out of the root barrel; the root remains the default for applications that use several components.

The package currently declares `vue` and `ai` as required peers. Styled components also require `@nuxt/ui` and Tailwind CSS. The Vite integration requires `vite`; `@nuxt/ui` and `vite` are optional peers only so applications using another entry point do not have to install them.

## Run an app in the browser

The workspace entries render a live app next to a docs page: a tutorial with the lesson on the left and the workspace on the right, or a playground. They run the app in a WebContainer through [`@vite-hub/web-container`](../web-container/README.md). The page that boots it must be cross-origin isolated, as that README shows.

| Import | Exports |
| --- | --- |
| `@vite-hub/ui/workspace` | `useWorkspace()`, the only module that imports `@vite-hub/web-container` |
| `@vite-hub/ui/workspace-shell` | `WorkspaceShell` with `layout: "tutorial" \| "playground"` |
| `@vite-hub/ui/workspace-file-tree` | `WorkspaceFileTree`, a `FileTree` with a dot on modified files |
| `@vite-hub/ui/workspace-editor` | `WorkspaceEditor`, CodeMirror 6 with the Pierre colors of `FileView` |
| `@vite-hub/ui/workspace-terminal` | `WorkspaceTerminal`, xterm.js |
| `@vite-hub/ui/workspace-preview` | `WorkspacePreview`, an iframe with a path bar, Reload, and Open in new tab |
| `@vite-hub/ui/workspace-boot-status` | `WorkspaceBootStatus`, the boot checklist with live times |
| `@vite-hub/ui/connect-panel` | `ConnectPanel`, `ConnectProviderRow`, and `useConnectStore()` |
| `@vite-hub/ui/browser-support-notice` | `BrowserSupportNotice` |

None of them is in the root barrel. CodeMirror and xterm load when the editor or the terminal mounts.

```vue
<script setup lang="ts">
import { useWorkspace } from "@vite-hub/ui/workspace";
import { WorkspaceBootStatus } from "@vite-hub/ui/workspace-boot-status";
import { WorkspaceEditor } from "@vite-hub/ui/workspace-editor";
import { WorkspacePreview } from "@vite-hub/ui/workspace-preview";
import { WorkspaceShell } from "@vite-hub/ui/workspace-shell";
import { WorkspaceTerminal } from "@vite-hub/ui/workspace-terminal";
import { computed, ref } from "vue";

const workspace = useWorkspace({ files: { "package.json": "...", "server.js": "..." } });
const tab = ref<"preview" | "terminal">("preview");
const source = computed({
  get: () => workspace.files.value["server.js"] ?? "",
  set: value => workspace.setFiles({ "server.js": value }),
});
</script>

<template>
  <WorkspaceShell v-model:tab="tab" layout="tutorial">
    <template #editor><WorkspaceEditor v-model="source" path="server.js" /></template>
    <template #preview><WorkspacePreview :url="workspace.previewUrl.value" /></template>
    <template #terminal><WorkspaceTerminal :output="workspace.logs.value" /></template>
    <template v-if="workspace.status.value !== 'ready'" #overlay>
      <WorkspaceBootStatus
        :status="workspace.status.value"
        :steps="workspace.steps.value"
        :failure="workspace.failure.value"
        :online="workspace.online.value"
        @retry="workspace.boot()"
        @retry-install="workspace.install()"
        @restart="workspace.restart()"
        @show-output="tab = 'terminal'"
      />
    </template>
  </WorkspaceShell>
</template>
```

- `useWorkspace({ files, snapshot?, install?, start?, env?, immediate? })` boots when the component mounts, installs, and starts the dev server. It returns `status`, `steps` (with timings), `support`, `failure` (`unsupported`, `boot`, `install`, or `server`, with the exit code), `files`, `modified`, `fs`, `previewUrl`, `logs`, and `online`.
- `setFiles(files, { mode: "merge" | "replace" })` writes to the container. Edits made before the mount ends are written when it ends. `reset()` puts back the original files. `install()` runs the install again, and `restart()` restarts the dev server.
- `env` is read on each run, so pass a getter or a computed, such as `useConnectStore().env(connect)`.
- `WorkspaceShell` has the slots `#toolbar`, `#files`, `#editor`, `#terminal`, `#preview`, `#connect`, and `#overlay`. A tutorial shows Preview, Terminal, and Connect as tabs under the editor. A playground puts the terminal under the editor and the preview at the side. Split sizes are kept in localStorage under `storageKey`. Hidden tab panels stay mounted and are `inert`.
- The preview origin does not answer a `fetch()` from the page, so `WorkspacePreview` shows it only in an iframe.
- `ConnectPanel` takes the providers of `defineConnect()` and a state for each one. It emits `connect` for pasted tokens and `oauth` with the provider definition (including its `app` or `clientId`) for the application to start authorization. It also emits `disconnect`, `remove-all`, and `copy-command`. It does not store tokens. `useConnectStore()` keeps them in sessionStorage by default (`storage: "local" | "memory"` also work), and falls back to memory when storage operations fail.
- `BrowserSupportNotice` shows only when `supported` is `false`, and only on the client. Pass `workspace.support.value?.supported` and, when unsupported, its `reason` to distinguish missing page isolation from browser limitations.

The demo page in `test/browser/page` shows every part in the tutorial layout. `pnpm --filter @vite-hub/ui test:browser` boots it with a real WebContainer in headless Chromium. It needs a Playwright Chromium and network access to StackBlitz and the npm registry. Set `WORKSPACE_TEST_PORT` to change its port (default `4796`) and `WORKSPACE_SCREENSHOTS=<dir>` to save a screenshot of each state.

## Nuxt

Add the package and its runtime peers to an existing Nuxt application:

```bash
pnpm add @vite-hub/ui @nuxt/ui ai tailwindcss vue @iconify-json/lucide @iconify-json/ph
```

Register the module:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@vite-hub/ui/nuxt"],
});
```

The module installs Nuxt UI, includes `@vite-hub/ui/styles.css`, and auto-imports public components such as `Chat`, `Markdown`, and `TraceRun`. It also adds the icons that these components use to the `@nuxt/icon` client bundle, because `@nuxt/icon` does not scan dependencies. The Lucide and Phosphor collections must be installed in the application. No separate Vue plugin registration is needed.

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
import { Markdown } from "@vite-hub/ui";
</script>

<template>
  <Markdown value="**ViteHub UI is ready.**" />
</template>
```

The page displays **ViteHub UI is ready.** in bold. This confirms the public component import and Markdown renderer; it does not configure a model or chat endpoint.

## Boundaries and requirements

- Published builds require Node.js 24.15 or newer. The package is pre-1.0, so pin its version and review changes before upgrading.
- The components render state supplied by the application. They do not send messages, fetch Agent Invocations, choose routes, persist sessions, or authorize access to instruction and trace data.
- `PromptInput` submits only in the ready state after attachment conversion finishes. It preserves the draft while blocked; Stop and Retry remain separate actions. Custom submit slots receive `canSubmit` and `preparingFiles`. The application owns draft recovery and clearing after a send; unmount the prompt when switching sessions with pending file reads.
- Primary chat and trace output supports Vue server rendering. Scrolling observers, clipboard actions, and attachment conversion use browser APIs and become interactive after hydration. Upload and persist raw files yourself when data URLs are not appropriate.
- The styled components depend on Nuxt UI components and tokens. `@vite-hub/ui/styles.css` adds ViteHub presentation but is not a replacement for the Tailwind and Nuxt UI imports.
- The package supplies accessible defaults for its message log, prompt, scroll controls, lists, and built-in actions. The application remains responsible for accessible names on custom controls and slots, meaningful status and error copy, focus behavior around application-owned navigation, and testing the completed interface.
- `FileTree` names its search input **Search files** by default. Pass `search-label` for a localized or context-specific accessible name.
- The headless entry point owns scrolling behavior, not appearance. Importing `@vite-hub/ui/headless` does not load the stylesheet or register Nuxt UI components.

## Documentation

- [UI overview and layer ownership](https://vitehub.dev/docs/ui)
- [Installation and package defaults](https://vitehub.dev/docs/ui/installation)
- [Chat and transport boundary](https://vitehub.dev/docs/ui/chat)
- [Prompt input](https://vitehub.dev/docs/ui/prompt-input) and [attachments](https://vitehub.dev/docs/ui/attachments)
- [Headless message scroller](https://vitehub.dev/docs/ui/message-scroller)
- [Comments](https://vitehub.dev/docs/ui/comments): Figma-style pins, threads, and a side list, built on [`@vite-hub/comments`](https://github.com/vite-hub/vitehub/tree/main/packages/comments)
- [Diff](https://vitehub.dev/docs/ui/diff) and [file-tree views](https://vitehub.dev/docs/ui/file-tree)

## Console views

The Agent Invocation list, view, inspector, timeline, and Capability inspector render ViteHub runtime records, so they live in the Console in `vite-hub`. Import `AgentInvocationList`, `AgentInvocation`, `AgentInvocationInspector`, and `AgentCapabilityInspector` from `vite-hub/console/ui`. Build an application-owned inspection page from the parts, such as `Trace` and `CodeBlock`, and from `ToolList`, which also documents Capability tool contracts. `ToolList` emits `select` with the tool name when a viewer chooses one. The model maker and provider marks of the Console come from [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT).
