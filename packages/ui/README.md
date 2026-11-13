# @vite-hub/ui

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fui&icon=npm)](https://npmx.dev/package/@vite-hub/ui)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fui&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/ui)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

Vue primitives for AI chat, traces, diffs, and file trees. The styled components compose [Nuxt UI](https://ui.nuxt.com/) and render [AI SDK](https://ai-sdk.dev/) message contracts; the headless entry point provides message-scrolling behavior without the styled component layer.

`Markdown` accepts a string or a parsed Content page. Comark UI block components and document styles are bundled, so readers do not install Comark packages or assemble a component map. `vite-hub/nuxt` auto-imports the primitive; Vite apps import it from `@vite-hub/ui`.

Markdown images and image attachments use compact thumbnails with an expanded preview. The preview preserves the full aspect ratio and supports Escape, focus return, and opening the original image. Prompt attachments have a separate Remove button.

## Choose an entry point

| Import                  | Use it for                                                                                | Application responsibility                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@vite-hub/ui`          | Every styled component: chat, prompt, Markdown, session, trace, diff, file tree, comments, and the shadcn/ui part families | State, transport, persistence, routes, and authorization                                       |
| `@vite-hub/ui/headless` | Message viewport, live-edge following, prepend preservation, message jumps, `useComments()`, and the Choices input parts | Markup and styles; Nuxt UI is not required                                                     |
| `@vite-hub/ui/markdown-editor` | `MarkdownEditor`, with Tiptap | Uploads and where the Markdown is saved |
| `@vite-hub/ui/workspace` | A live app in the browser: editor, terminal, preview, boot checklist, Connect, and `PlaygroundContainer`, with CodeMirror and xterm | Files, tokens, and the cross-origin isolated route |
| `@vite-hub/ui/playground` | Share links and zips for any playground, with no UI. It runs in Node too | Where the links and zips go |
| `@vite-hub/ui/theme` and `@vite-hub/ui/theme.css` | `vitehubTheme`, the Nuxt UI app config, and the tokens and focus ring. The tokens use shadcn/ui names, such as `--background` and `--radius`, which an app can override. Import the theme in `nuxt.config` or `app.config` | Loading Nuxt UI and Tailwind CSS |
| `@vite-hub/ui/vite`     | Vue with Vite setup                                                                       | Configures the Nuxt UI and Comark Vite plugins                                                 |
| `@vite-hub/ui/styles.css` | The styles of every part | Tailwind CSS and the Nuxt UI imports |

Import components from the root. A production build keeps only the components that the app imports. `markdown-editor` and `workspace` have their own entries because their dependencies are large, and a chat page must not load them. The components do not need a ViteHub Agent: `Chat` and `PromptInput` render the messages and status of any AI SDK chat, such as `new Chat()` of `@ai-sdk/vue` on a route that returns `streamText().toUIMessageStreamResponse()`.

`vite-hub/nuxt` registers the `vitehub` Iconify collection, so `i-vitehub-kv` works in `UIcon`. The icon rail of ViteHub docs and the Console is in `@vite-hub/docs/primitive-rail`. Its styles stay in `@vite-hub/ui/styles.css`.

The parts `Message`, `Bubble`, `Marker`, `Trace`, and `Attachment` follow the [shadcn/ui agentic components](https://ui.shadcn.com/docs/changelog/2026-10-ai-elements): the same part names, props, and `data-slot` attributes. Their default styles map shadcn/ui tokens to Nuxt UI tokens and live in the `components` layer of `styles.css`, so Tailwind utility classes on a part override them. Import them under another name, for example `import { Message as VhMessage } from "@vite-hub/ui"`, when the application already has a `Message` or `Trace` component.

The package currently declares `vue` and `ai` as required peers. Styled components also require `@nuxt/ui` and Tailwind CSS. The Vite integration requires `vite`; `@nuxt/ui` and `vite` are optional peers only so applications using another entry point do not have to install them.

## Edit Markdown

`MarkdownEditor` from `@vite-hub/ui/markdown-editor` edits Markdown with [comark-ui's editor](https://comark-ui.onmax.me/guide/editor/) and Nuxt UI's bubble toolbar, "/" menu, and drag handle. Bind the Markdown with `v-model`, or pass `editor` with a Tiptap editor the app made, such as a Realtime room's. A document that the editor can't save unchanged opens read-only.

Pass `upload` to take pasted and dropped images, video, and audio, and to add Image to the "/" menu, which opens the file picker. Each file shows a placeholder with its percentage only on your screen, so a collaborative room never holds a half-uploaded file. A string is a route that returns `blob.handleUpload()`, and the store must be served (`blob.serve`) so the file has a URL:

```vue
<script setup lang="ts">
import { MarkdownEditor } from "@vite-hub/ui/markdown-editor";
import { ref } from "vue";

const markdown = ref("# Release notes\n");
</script>

<template>
  <MarkdownEditor v-model="markdown" upload="/api/uploads" @upload-error="(error, file) => console.error(file.name, error)" />
</template>
```

```ts [server/api/uploads.post.ts]
import { defineEventHandler } from "h3";
import { blob } from "vite-hub/blob";

// Check who may upload before this call
export default defineEventHandler(async (event) => {
  const [error, files] = await blob.handleUpload(event, {
    ensure: { maxSize: "8MB", types: ["image", "video", "audio"] },
    put: { prefix: "uploads", addRandomSuffix: true },
  });
  if (error) throw error;
  return files;
});
```

`upload` also takes a function, `(file, progress) => Promise<url>`, for any other storage; `blobUpload(route)` is the one a string uses. The default slot receives `{ editor }` for more menus. The entry isn't in the root barrel, so pages that only render Markdown don't load Tiptap. It needs the Tiptap packages that Nuxt UI's editor uses: `@tiptap/core`, `@tiptap/pm`, `@tiptap/vue-3`, `@tiptap/starter-kit`, `@tiptap/extension-image`, `@tiptap/extension-list`, and `@tiptap/extension-table`.

## Run an app in the browser

The workspace parts render a live app next to a docs page: a tutorial with the lesson on the left and the workspace on the right, or a playground. `useWebContainer()` from [`@vite-hub/web-container/vue`](../web-container/README.md) runs the app in a WebContainer, and the parts render its state. The page that boots it must be cross-origin isolated, as the [WebContainer docs](https://vitehub.dev/docs/web-container/get-started#make-the-page-cross-origin-isolated) show.

`@vite-hub/ui/workspace` exports `WorkspaceShell` (with `layout: "tutorial" | "playground"`), `WorkspaceFileTree` (a `FileTree` with a dot on modified files), `WorkspaceEditor` (CodeMirror 6 with the Pierre colors of `FileView`), `WorkspaceTerminal` (xterm.js), `WorkspacePreview` (an iframe with a path bar, Reload, and Open in new tab), `WorkspaceBootStatus` (the boot checklist with live times), `BrowserSupportNotice`, `ConnectPanel`, `ConnectProviderRow`, and `useConnectStore()`, which connect the reader's accounts, and `PlaygroundContainer` with `usePlaygroundDevice()`, a complete playground built from these parts. The entry is not in the root barrel. CodeMirror and xterm load when the editor or the terminal mounts.

`PlaygroundRender`, a playground that renders files in the page, is in the root `@vite-hub/ui`. See [Render files in the page](#render-files-in-the-page). `@vite-hub/ui/playground` has the share links and zips: `encodePlaygroundLink()`, `decodePlaygroundLink()`, `readPlaygroundHash()`, `playgroundUrl()`, `zipFiles()`, and `downloadZip()`.

A share link holds the files in its URL hash, so nothing is stored on a server. Only the changes from the template go into the link, deflated and in base64url. `@vite-hub/ui/playground` has no UI and runs in browsers and in Node, so a build can write links and starter zips too.

```ts
import { decodePlaygroundLink, encodePlaygroundLink, playgroundUrl, readPlaygroundHash } from "@vite-hub/ui/playground";

const kv = { id: "kv", files: { "server/api/hello.get.ts": "export default () => 'hello'\n" } };
const files = { ...kv.files, "server/api/hello.get.ts": "export default () => 'edited'\n" };
const code = await encodePlaygroundLink({ template: "kv", files }, kv.files);
const url = playgroundUrl("/playground", code); // "/playground#code=…"

// A malformed link, an unsafe path, or an unknown template gives undefined.
const state = await decodePlaygroundLink(readPlaygroundHash(location.hash) ?? "", [kv]);
```

A playground without templates, such as one Markdown file, leaves `template` out. Links longer than `playgroundLinkLimit` (16,000 characters) are cut by chat apps, so offer `downloadZip()` instead.

`PlaygroundContainer` is the whole page part: a toolbar with the run state, a template menu, Download, Copy link, and Restart and Discard changes. Under it are the file tree, the editor, the preview, and the dev server console. It marks edited files, asks before it replaces edits, and opens `#code=` links. Desktops boot it on their own, tablets boot it on a tap, and phones get a card with Copy link and Download files. A browser without WebContainer support gets `BrowserSupportNotice`.

```vue
<script setup lang="ts">
import { PlaygroundContainer } from "@vite-hub/ui/workspace";
import { fetchSnapshot } from "@vite-hub/web-container";
import { defineConnect } from "@vite-hub/web-container/connect";

const connect = defineConnect({ github: true });
const files = {
  "package.json": JSON.stringify({ scripts: { dev: "vite --port 3000" }, devDependencies: { vite: "^8.0.0" } }),
  "index.html": "<h1>Hello</h1>",
};
const templates = [
  { id: "hello", label: "Hello", files, open: "index.html", snapshot: () => fetchSnapshot(["/snapshots/hello.0.bin"]) },
  { id: "empty", label: "Empty", files: { ...files, "index.html": "" } },
];
</script>

<template>
  <PlaygroundContainer :templates="templates" label="playground" name="my-app" :port="3000" :connect="connect" :tabs="[{ value: 'messages', label: 'Messages' }]">
    <template #messages="{ workspace }">
      <pre>{{ workspace.files.value["index.html"] }}</pre>
    </template>
  </PlaygroundContainer>
</template>
```

- Props: `templates` (one or more, each `{ id, label, files, description?, open?, preview?, snapshot? }`), `template` (the id to open first), `layout` (`"playground"` or `"tutorial"`), `label` (the lowercase name in the Open button and the cards, default `"workspace"`), `name` (the start of the zip name), `port`, `connect`, `tabs`, `share` (default `true`), `v-model:selected`, and `v-model:open`.
- Templates with the same `snapshot` function switch in place. Another snapshot, or an edited `package.json`, boots a new workspace.
- Slots: `#toolbar` adds buttons before Download, `#banner` shows under the toolbar, and each tab of `tabs` shows the slot with its `value`. These slots get `{ workspace, template, edited, show, showTab, guard }`, and `@context` gives the same object to code outside the container. `#intro` and `#fallback` show around the card when the workspace does not show.
- It emits `update:template` when the reader opens a template or discards the changes to one.
- A tutorial gives one template with the files of its step, sets `layout="tutorial"` and `:share="false"`, adds Solve in `#toolbar`, and writes the next step through `workspace.setFiles()`. A change to the files of the open template moves the edit baseline, so the next step starts with no edits.

```vue
<script setup lang="ts">
import { WorkspaceBootStatus, WorkspaceEditor, WorkspacePreview, WorkspaceShell, WorkspaceTerminal } from "@vite-hub/ui/workspace";
import { useWebContainer } from "@vite-hub/web-container/vue";
import { computed, ref } from "vue";

const workspace = useWebContainer({ files: { "package.json": "...", "server.js": "..." } });
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

- `useWebContainer()` returns the state that the parts take: `status`, `steps`, `failure`, `files`, `modified`, `previewUrl`, `logs`, and `online`. Its [README](../web-container/README.md#run-it-from-vue) lists the options. Pass `env: useConnectStore().env(connect)` to give the dev server the reader's tokens.
- `WorkspaceShell` has the slots `#toolbar`, `#files`, `#editor`, `#terminal`, `#preview`, `#connect`, and `#overlay`. A tutorial shows Preview, Terminal, and Connect as tabs under the editor. A playground puts the preview at the side and the other tabs under the editor. `tabs` sets the tabs and their order, with a label and an optional `badge` each, and each tab shows the slot with its `value`. Split sizes are kept in localStorage under `storageKey`. Hidden tab panels stay mounted and are `inert`.
- The preview origin does not answer a `fetch()` from the page, so `WorkspacePreview` shows it only in an iframe.
- `BrowserSupportNotice` shows only when `supported` is `false`, and only on the client. Pass `workspace.support.value?.supported` and, when unsupported, its `reason` to distinguish missing page isolation from browser limitations. `description` replaces the text for a tutorial with what the reader of your page can do instead.

The demo page in `test/browser/page` shows every part in the tutorial layout. `pnpm --filter @vite-hub/ui test:browser` boots it with a real WebContainer in headless Chromium. It needs a Playwright Chromium and network access to StackBlitz and the npm registry. Set `WORKSPACE_TEST_PORT` to change its port (default `4796`) and `WORKSPACE_SCREENSHOTS=<dir>` to save a screenshot of each state.

## Render files in the page

`PlaygroundRender` from `@vite-hub/ui` is a playground for code that renders in the browser, such as Markdown or YAML. It needs no WebContainer. You give it a `render` function, the editor panes, and the examples. It shows the editors, the examples, the issues, and the preview.

```vue
<script setup lang="ts">
import { PlaygroundRender, type PlaygroundFiles } from "@vite-hub/ui";
import { marked } from "marked";

const presets = [
  { id: "hello", label: "Hello", group: "Basics", files: { "content.md": "# Hello\n" } },
  { id: "list", label: "A list", group: "Basics", files: { "content.md": "- One\n- Two\n" } },
];
const panes = [{ file: "content.md", label: "Markdown", language: "markdown" }];
const languages = [() => import("shiki/langs/markdown.mjs")];

async function render(files: PlaygroundFiles) {
  return { html: await marked.parse(files["content.md"] ?? ""), issues: [] };
}
</script>

<template>
  <PlaygroundRender :presets :panes :languages :render class="h-[70vh]" />
</template>
```

- The state is a set of files. Each edit renders 200 ms after the last key, and a render that ends after a newer one is dropped. The preview keeps its scroll position.
- The URL hash holds the files as a share link of `@vite-hub/ui/playground`, with the open example as its template. The playground replaces the hash, so Back leaves the page. It loads the hash again on `hashchange`, and says so when a link cannot be read.
- `render(files)` returns `{ html, issues? }`. An issue is `{ message, line? }`. A thrown error shows as an issue.
- `previewDocument(html, files)` wraps the HTML in the preview page, with your stylesheets, body class, and theme. The default is a plain white page. The preview runs scripts in a sandboxed frame with its own origin, so a shared link cannot reach your page.
- `languages` are Shiki languages for the `language` of each pane. Shiki loads after the first render. Without `languages`, the panes are plain text.
- `preset` is the id of the example that opens first. Copy link refuses links longer than `playgroundLinkLimit`; Download gives a zip of the files instead. Reset asks first, then goes back to the example.
- A pane with `slot: "theme"` shows the `#theme` slot in place of the editor, with `{ pane, value, files, setFile }`. The `#toolbar` slot gets `{ files, preset, setFile }`, and the `#preset` slot gets `{ preset, active }` to draw each example.

## Nuxt

Add the package, ViteHub, and the runtime peers to an existing Nuxt application:

```bash
pnpm add vite-hub @vite-hub/ui @nuxt/ui ai tailwindcss vue @iconify-json/lucide
```

Register Nuxt UI and `vite-hub/nuxt`:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@nuxt/ui", "vite-hub/nuxt"],
  css: ["~/assets/css/main.css"],
});
```

Load Tailwind, Nuxt UI, and the package styles in that order:

```css
/* assets/css/main.css */
@import "tailwindcss";
@import "@nuxt/ui";
@import "@vite-hub/ui/styles.css";
```

`vite-hub/nuxt` gives the components Nuxt UI's Nuxt icon and adds the icons that they use to the `@nuxt/icon` client bundle, because `@nuxt/icon` does not scan dependencies. It also registers the `vitehub` collection, so names such as `<UIcon name="i-vitehub-kv" />` keep working. The Lucide collection must be installed in the application. It auto-imports public components such as `Chat`, `Markdown`, and `TraceRun`. No separate Vue plugin registration is needed. The stylesheet stays an explicit import.

`@vite-hub/ui/nuxt` is internal. `vite-hub/nuxt` and `@vite-hub/docs/nuxt` load it, and it can change in any release. Do not add it to Nuxt `modules`.

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

Unlike `vite-hub/nuxt`, the Vite integration does not auto-register ViteHub UI components. Import them from `@vite-hub/ui` in each component or use the application's component-registration convention.

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

- Published builds require Node.js 22.22 or newer. The package is pre-1.0, so pin its version and review changes before upgrading.
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
- [Icons](https://vitehub.dev/docs/ui/installation#icons): the parts read Nuxt UI's `appConfig.ui.icons` and, for names Nuxt UI does not have, `appConfig.viteHubUI.icons`
- [Chat and transport boundary](https://vitehub.dev/docs/ui/chat)
- [Prompt input](https://vitehub.dev/docs/ui/prompt-input) and [attachments](https://vitehub.dev/docs/ui/attachments)
- [Headless message scroller](https://vitehub.dev/docs/ui/message-scroller)
- [Comments](https://vitehub.dev/docs/ui/comments): Figma-style pins, threads, and a side list, built on [`@vite-hub/comments`](https://github.com/vite-hub/vitehub/tree/main/packages/comments)
- [Diff](https://vitehub.dev/docs/ui/diff) and [file-tree views](https://vitehub.dev/docs/ui/file-tree)

## Console views

The Agent Invocation list, view, inspector, timeline, and Capability inspector render ViteHub runtime records, so they live in the Console in `vite-hub`. Import `AgentInvocationList`, `AgentInvocation`, `AgentInvocationInspector`, and `AgentCapabilityInspector` from `vite-hub/console/ui`. Build an application-owned inspection page from the parts, such as `Trace` and `CodeBlock`, and from `ToolList`, which also documents Capability tool contracts. `ToolList` emits `select` with the tool name when a viewer chooses one. The model maker and provider marks of the Console come from [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT).
