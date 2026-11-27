# @vite-hub/ui

[![npm version](https://img.shields.io/npm/v/@vite-hub/ui)](https://npmx.dev/package/@vite-hub/ui)
[![npm downloads](https://img.shields.io/npm/dm/@vite-hub/ui)](https://npmx.dev/package/@vite-hub/ui)
[![license](https://img.shields.io/static/v1?label=license&message=Apache-2.0&color=blue)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://img.shields.io/static/v1?label=docs&message=vitehub.dev&color=blue)](https://vitehub.dev/docs)

Vue primitives for AI chat, traces, diffs, and file trees. The styled components render [ui-sdk](https://ui-sdk.dev) components, or the components that the app gives them, such as [Nuxt UI](https://ui.nuxt.com/)'s, and render [AI SDK](https://ai-sdk.dev/) message contracts; the headless entry point provides message-scrolling behavior without the styled component layer.

`Markdown` accepts a string or a parsed Content page. Comark UI block components and document styles are bundled, so readers do not install Comark packages or assemble a component map. `vite-hub/nuxt` auto-imports the primitive; Vite apps import it from `@vite-hub/ui`.

Markdown images and image attachments use compact thumbnails with an expanded preview. The preview preserves the full aspect ratio and supports Escape, focus return, and opening the original image. Prompt attachments have a separate Remove button.

## Choose an entry point

| Import                  | Use it for                                                                                | Application responsibility                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@vite-hub/ui`          | Every styled component: chat, prompt, Markdown, session, trace, diff, file tree, comments, and the shadcn/ui part families | State, transport, persistence, routes, and authorization                                       |
| `@vite-hub/ui/headless` | Message viewport, live-edge following, prepend preservation, message jumps, `useComments()`, and the Choices input parts | Markup and styles; Nuxt UI is not required                                                     |
| `@vite-hub/ui/markdown-editor` | `MarkdownEditor`, with Tiptap | Uploads and where the Markdown is saved |
| `@vite-hub/ui/workspace` | A live app in the browser: editor, terminal, preview, boot checklist, Connect, and `Workspace` with the `webContainer()` and `render()` runners, with CodeMirror and xterm | Files, tokens, and the cross-origin isolated route |
| `@vite-hub/ui/motion` | The motion layer: press, toggle, select, drag, and appear motion by role, the shared spring engine, and reduced motion. No Vue, so a plain TypeScript page or a shadow root can use it | Nothing: `createViteHubUI()` and the Nuxt module install it |
| `@vite-hub/ui/motion/core` | The same layer, where `installMotion(root, { effects })` runs only the effects that you list, such as `pressEffect`, so a small script bundles only those | Which effects the script runs |
| `@vite-hub/ui/playground` | Share links and zips for any playground, with no UI. It runs in Node too | Where the links and zips go |
| `@vite-hub/ui/theme` and `@vite-hub/ui/theme.css` | `vitehubTheme`, the Nuxt UI app config, and the tokens and focus ring. The tokens use shadcn/ui names, such as `--background` and `--radius`, which an app can override. Import the theme in `nuxt.config` or `app.config` | Loading Nuxt UI and Tailwind CSS |
| `@vite-hub/ui/vite`     | Vue with Vite setup                                                                       | Configures the Comark Vite plugin                                                              |
| `@vite-hub/ui/styles.css` | The styles of every part | Tailwind CSS, and the `@vite-hub/kit` styles or the Nuxt UI imports |
| `@vite-hub/ui/comment-marks.css` | Comment pins, areas, and text highlights in plain CSS, for a page or a shadow root without Vue. `styles.css` includes it | Rendering the marks with their data attributes |

Import components from the root. A production build keeps only the components that the app imports. `markdown-editor` and `workspace` have their own entries because their dependencies are large, and a chat page must not load them. The components do not need a ViteHub Agent: `Chat` and `PromptInput` render the messages and status of any AI SDK chat, such as `new Chat()` of `@ai-sdk/vue` on a route that returns `streamText().toUIMessageStreamResponse()`.

`vite-hub/nuxt` registers the `vitehub` Iconify collection, so `i-vitehub-kv` works in `UIcon`. The icon rail of ViteHub docs and the Console is in `@vite-hub/docs/primitive-rail`. Its styles stay in `@vite-hub/ui/styles.css`.

The parts `Message`, `Bubble`, `Marker`, `Trace`, and `Attachment` follow the [shadcn/ui agentic components](https://ui.shadcn.com/docs/changelog/2026-10-ai-elements): the same part names, props, and `data-slot` attributes. Their default styles map shadcn/ui tokens to Nuxt UI tokens and live in the `components` layer of `styles.css`, so Tailwind utility classes on a part override them. Import them under another name, for example `import { Message as VhMessage } from "@vite-hub/ui"`, when the application already has a `Message` or `Trace` component.

The package currently declares `vue` and `ai` as required peers. Styled components also require Tailwind CSS and a style family for their ui-sdk components, such as `@vite-hub/kit/styles/default.css`. The Vite integration requires `vite`, an optional peer, so applications using another entry point do not have to install it. `@nuxt/ui` is not a peer: an app that keeps Nuxt UI passes its components (see [Components that the parts render](#components-that-the-parts-render)).

`RelativeTime` shows the exact time in a tooltip when the app gives it a `UTooltip`, such as Nuxt UI's inside `UApp`. Otherwise it uses the native `title` attribute.

## Edit Markdown

`MarkdownEditor` from `@vite-hub/ui/markdown-editor` edits Markdown with [comark-ui's editor](https://comark-ui.onmax.me/guide/editor/), a bubble toolbar, a "/" menu, and a drag handle: the ui-sdk ones by default, or Nuxt UI's when the app gives them (see [Components that the parts render](#components-that-the-parts-render)). Bind the Markdown with `v-model`, or pass `editor` with a Tiptap editor the app made, such as a Realtime room's. A document that the editor can't save unchanged opens read-only.

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

`upload` also takes a function, `(file, progress) => Promise<url>`, for any other storage; `blobUpload(route)` is the one a string uses. The default slot receives `{ editor }` for more menus. The entry isn't in the root barrel, so pages that only render Markdown don't load Tiptap. It needs the Tiptap packages that Nuxt UI's editor uses: `@tiptap/core`, `@tiptap/pm`, `@tiptap/vue-3`, `@tiptap/starter-kit`, `@tiptap/extension-image`, `@tiptap/extension-list`, and `@tiptap/extension-table`. With the default ui-sdk components, also install `@tiptap/extension-drag-handle`, `@tiptap/extension-drag-handle-vue-3`, and `@floating-ui/dom`, which Nuxt UI otherwise brings.

The menus run each item's `kind`, such as `{ kind: "heading", level: 2 }`, through the handlers that the editor provides. `createEditorHandlers()` returns them, and `mapEditorItems(editor, items)` turns editor items into dropdown entries with `active`, `disabled`, and `onSelect`, as Nuxt UI's `mapEditorItems()` does. Provide your own under `editorHandlersKey` to add kinds; both sets read them.

## Run an app in the browser

The workspace parts render a live app next to a docs page: a tutorial with the lesson in a column on the left, or a playground. `useWebContainer()` from [`@vite-hub/web-container/vue`](../web-container/README.md) runs the app in a WebContainer, and the parts render its state. The page that boots it must be cross-origin isolated, as the [WebContainer docs](https://vitehub.dev/docs/web-container/get-started#make-the-page-cross-origin-isolated) show.

`@vite-hub/ui/workspace` exports `WorkspaceShell` (with `layout: "side" | "guide-top" | "guide-side"`), `WorkspaceFileTree` (a `FileTree` with a dot on modified files), `WorkspaceEditor` (CodeMirror 6 with the Pierre colors of `FileView`), `WorkspaceTerminal` (xterm.js), `WorkspacePreview` (the preview in a browser frame: Back, Forward, Reload, the page address, a Desktop, Tablet, and Phone width switch, and Open in new tab), `WorkspaceBootStatus` (the boot checklist with live times), `BrowserSupportNotice`, `ConnectPanel`, `ConnectProviderRow`, and `useConnectStore()`, which connect the reader's accounts, and `Workspace` with `useWorkspace()` and `useWorkspaceDevice()`, a complete playground or lesson built from these parts. The bar parts are `WorkspaceBar` (the 44px bar), `WorkspaceExamples` (the examples menu, with group headings), `WorkspaceSidebar` (a panel over the workspace with Reset, Download, and Copy link at the bottom), and `WorkspaceStart` (the examples as cards on a first visit). See [Workspace bar](https://vitehub.dev/docs/ui/workspace-bar). The entry is not in the root barrel. CodeMirror and xterm load when the editor or the terminal mounts.

The code side has four parts for the slots of `WorkspaceShell`: `WorkspaceFileTree` takes the edited paths as `edited`, a list or a set, and draws a type icon per file and a dot per edited file. `WorkspaceEditorHead` shows the path as a breadcrumb and a wrap button. `WorkspaceEditor` takes `v-model:wrap`, which Alt+Z toggles, and emits `cursor`. `WorkspaceStatus` shows the cursor, the language from `workspaceLanguage(path)`, and the indentation.

`@vite-hub/ui/playground` has the share links and zips: `encodePlaygroundLink()`, `decodePlaygroundLink()`, `readPlaygroundHash()`, `playgroundUrl()`, `zipFiles()`, and `downloadZip()`.

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

`Workspace` is the whole page part: a bar with the run state, an examples menu, Reset, Download, Copy link, and a More menu. Under it are the file tree, the editor, and the output of its runner. It marks edited files, asks before it replaces edits, and opens `#code=` links. `webContainer()` runs the files as an app with a Preview tab, a Terminal tab, and a Connect tab for `connect`. Desktops boot it on their own, tablets boot it on a tap, and phones get a card with Copy link and Download files. A browser without WebContainer support gets `BrowserSupportNotice`. `render()` runs the files through a function in the page, on every device. See [Workspace](https://vitehub.dev/docs/ui/workspace).

```vue
<script setup lang="ts">
import { webContainer, Workspace } from "@vite-hub/ui/workspace";
import { fetchSnapshot } from "@vite-hub/web-container";
import { defineConnect } from "@vite-hub/web-container/connect";

const connect = defineConnect({ github: true });
const files = {
  "package.json": JSON.stringify({ scripts: { dev: "vite --port 3000" }, devDependencies: { vite: "^8.0.0" } }),
  "index.html": "<h1>Hello</h1>",
};
const examples = [
  { id: "hello", label: "Hello", files, open: "index.html" },
  { id: "empty", label: "Empty", files: { ...files, "index.html": "" } },
];
const hello = () => fetchSnapshot(["/snapshots/hello.0.bin"]);
const runner = webContainer({ port: 3000, connect, snapshot: () => hello });
</script>

<template>
  <Workspace :examples :runner label="playground" name="my-app" :tabs="[{ value: 'messages', label: 'Messages' }]">
    <template #messages="{ files }">
      <pre>{{ files["index.html"] }}</pre>
    </template>
  </Workspace>
</template>
```

- Props: `examples` (one or more, each `{ id, label, files, description?, group?, open?, preview? }`), `runner`, `v-model:example` (the open example), `v-model:selected`, `steps` with `v-model:step` and `guide` (`"top"` or `"side"`) for a lesson, `tabs`, `share` (default `true`), `name` (the start of the zip name), `start` (show the examples as cards on a first visit without a share link), `label` (the lowercase name in the Open button and the cards, default `"workspace"`), `reset` (the files that Reset writes, from the current files and the example), and `v-model:open`. The examples menu groups the examples by `group`.
- Examples with the same `snapshot` loader and the same `package.json` switch in place. Another snapshot, or an edited `package.json`, boots a new run. One runner boots one WebContainer at a time.
- Slots: `#bar-lead` and `#bar-actions` add controls to the bar, `#sidebar` fills the sidebar and moves Reset, Download, and Copy link to its bottom, `#guide` holds the text of a step, `#banner` shows under the bar, and each tab of `tabs` shows the slot with its `value`. These slots get `{ files, setFile, edited, example, show, showTab, guard, runner, run }`, and `useWorkspace()` gives the same values to a component in a slot. `#intro` and `#fallback` show around the card when the workspace does not show.
- The share link keeps the key `template` for the example id, so older links open.
- While the start screen shows, the workspace starts no run and loads no snapshot. A pick of a card or a menu item starts the picked example and moves focus to the bar.
- `WorkspaceShell` has three layouts:
  - `side` (default): the code on the left and the output at the side, with a draggable line between them.
  - `guide-top`: the `#guide` pane over the code, with a draggable line between them, and the output at the side.
  - `guide-side`: the `#guide` pane on the left is up to 360px wide and takes at most half the available width. On the right, the output takes 40% at the top and the code sits under it.
- The `#bar` slot is 44px high. The `#editor-head` row and the output tab bar are 32px high, so their bottom lines align. The `#status` line is 24px high. The draggable lines also move with the arrow keys, Home, and End. Split sizes are kept in localStorage under `storageKey`. Hidden tab panels stay mounted and are `inert`.
- `tabs` sets the tabs and their order, with a label and an optional `badge` each. For custom tabs, use `#tab-<value>` (for example, `#tab-status`). A slot named by the value alone still works if it is not a layout slot and does not start with `tab-`.
- The preview origin does not answer a `fetch()` from the page, so `WorkspacePreview` shows it only in an iframe. The page cannot read the address or the history of that cross-origin frame either, so pass `previewScript: workspacePreviewScript` to `useWebContainer()`. The script reports the address of each preview page, and Back and Forward work. Without it, the bar shows the path that it opened, and Back and Forward stay disabled. `webContainer()` passes it.
- The width switch of `WorkspacePreview` shows the page at 768 (Tablet) or 390 (Phone) CSS pixels in a `DeviceFrame`, scaled down to fit the pane. Desktop fills the pane. Use `v-model:device`, or let it keep the last width in localStorage.
- `BrowserSupportNotice` shows only when `supported` is `false`, and only on the client. Pass `workspace.support.value?.supported` and, when unsupported, its `reason` to distinguish missing page isolation from browser limitations. `description` replaces the text for a tutorial with what the reader of your page can do instead.
- The learn parts fill the `#guide` and `#bar` slots of a lesson. `WorkspaceGuide` shows the position and title of the step, your rendered Markdown in its default slot (it never parses Markdown), and Back and Next at the bottom of the pane. `WorkspaceSteps` is the steps menu with Previous and Next for the bar. Bind both with `v-model:step`. `WorkspaceTask` is the task box of a step. `WorkspaceFileLink` opens its `path` through the opener of `provideWorkspaceFileOpener({ show })` and emits `open`. `WorkspaceIssues` lists `{ message, line? }` issues, and the Issues tab of `render()` uses it. See [Workspace guide](https://vitehub.dev/docs/ui/workspace-guide).

The demo page in `test/browser/page` shows every part in the `guide-side` layout. `pnpm --filter @vite-hub/ui test:browser` boots it with a real WebContainer in headless Chromium. It needs a Playwright Chromium and network access to StackBlitz and the npm registry. Set `WORKSPACE_TEST_PORT` to change its port (default `4796`) and `WORKSPACE_SCREENSHOTS=<dir>` to save a screenshot of each state.

`pnpm --filter @vite-hub/ui test:workspace-parts` mounts the parts on a fake WebContainer in headless Chromium at 1280x760 and checks their sizes against the design. Each part is a file in `test/browser/workspace-parts/fixtures` and its checks are a file in `test/browser/workspace-parts/checks`. Set `WORKSPACE_PARTS_SCREENSHOTS=<dir>` to save a screenshot of each part.

## Render files in the page

`render(fn)` from `@vite-hub/ui/workspace` is a runner for code that renders in the browser, such as Markdown or YAML. It needs no WebContainer, so every device runs it.

```vue
<script setup lang="ts">
import { render, Workspace } from "@vite-hub/ui/workspace";
import { marked } from "marked";

const examples = [
  { id: "hello", label: "Hello", group: "Basics", files: { "content.md": "# Hello\n" } },
  { id: "list", label: "A list", group: "Basics", files: { "content.md": "- One\n- Two\n" } },
];
const runner = render(async files => ({ html: await marked.parse(files["content.md"] ?? "") }));
</script>

<template>
  <Workspace :examples :runner name="markdown" class="h-[70vh]" />
</template>
```

- Each edit renders 200 ms after the last key, and a render that ends after a newer one is dropped. The output keeps its scroll position.
- `fn(files)` returns `{ html, issues? }`. An issue is `{ message, line? }`. A thrown error shows as an issue in the Issues tab.
- `document(html, files)`, the second argument, wraps the HTML in the output page, with your stylesheets, body class, and theme. The default is a plain white page. The output runs scripts in a sandboxed frame with its own origin, so a shared link cannot reach your page.

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

`vite-hub/nuxt` adds the icons that the components use to the `@nuxt/icon` client bundle, because `@nuxt/icon` does not scan dependencies. It also registers the `vitehub` collection, so names such as `<UIcon name="i-vitehub-kv" />` keep working. The Lucide collection must be installed in the application. It auto-imports public components such as `Chat`, `Markdown`, and `TraceRun`. No separate Vue plugin registration is needed. The stylesheet stays an explicit import.

The parts render the ui-sdk components, also in a Nuxt UI app. To render Nuxt UI's, register them as global components in a plugin. A part uses a global component with its name before the ui-sdk one:

```ts
// app/plugins/vitehub-ui.ts
import { UButton, UDropdownMenu, UIcon, UInput, UModal, UTabs, UTooltip } from "#components";

export default defineNuxtPlugin((nuxtApp) => {
  for (const [name, component] of Object.entries({ UButton, UDropdownMenu, UIcon, UInput, UModal, UTabs, UTooltip }))
    nuxtApp.vueApp.component(name, component);
});
```

`@vite-hub/ui/nuxt` is internal. `vite-hub/nuxt` and `@vite-hub/docs/nuxt` load it, and it can change in any release. Do not add it to Nuxt `modules`. Its `components` option is the path of a module that default-exports the components, as `@vite-hub/docs/nuxt` passes Nuxt UI's.

## Vue with Vite

Add the runtime peers and the kit styles to an existing Vue and Vite application:

```bash
pnpm add @vite-hub/ui @vite-hub/kit ai tailwindcss vue
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

Register the ViteHub UI Vue plugin:

```ts
// src/main.ts
import { createViteHubUI } from "@vite-hub/ui";
import { createApp } from "vue";
import App from "./App.vue";
import "./assets/main.css";

createApp(App).use(createViteHubUI()).mount("#app");
```

Load Tailwind, the kit styles, and the package styles in that order:

```css
/* src/assets/main.css */
@layer theme, base, comark, ui-sdk, components, utilities;
@import "tailwindcss";
@import "@vite-hub/kit/styles/tokens.css";
@import "@vite-hub/kit/styles/default.css";
@import "@vite-hub/ui/styles.css";
```

Unlike `vite-hub/nuxt`, the Vite integration does not auto-register ViteHub UI components. Import them from `@vite-hub/ui` in each component or use the application's component-registration convention.

## Motion

Controls get the same motion from what a person does with them, not from code of their own (see [docs/design/motion.md](../../docs/design/motion.md)). `createViteHubUI()` installs the motion layer in the browser, and the Nuxt module does it through the same plugin. A pressed `button`, link, tab, radio, option, menu item, or checkbox squashes and springs back past rest. A pressed switch grows its knob instead of squashing the whole control. Non-transformable inline controls, such as links in running text, keep their layout and do not squash. A pointer press near the edge of a control stays still if a squash would risk missing the click. Under `prefers-reduced-motion`, the press stays still.

- Turn the layer off for one subtree with `data-motion="none"`, such as a canvas or an animated figure that draws its own motion.
- Turn it off for the app with `createViteHubUI({ motion: false })`.
- Without Vue, call it yourself. With no argument it covers the document. A surface on someone else's page, such as a bar in a shadow root, passes its host element and its shadow roots instead, so the page around it does not move:

```ts
import { installMotion } from "@vite-hub/ui/motion";

const host = document.createElement("div");
document.body.append(host);
const uninstall = installMotion(host.attachShadow({ mode: "open" }));
```

That brings every effect. A script with its own small bundle, such as a toolbar that you put on other pages, takes `installMotion` from `@vite-hub/ui/motion/core` and lists the effects it runs, so the others stay out of the bundle:

```ts
import { appearEffect, installMotion, pressEffect } from "@vite-hub/ui/motion/core";

const bar = document.createElement("div");
document.body.append(bar);
const uninstall = installMotion(bar.attachShadow({ mode: "open" }), { effects: [pressEffect, appearEffect] });
```

Four parts move with the helpers of the motion layer, for events that only the component knows:

- `MotionList` replaces `<TransitionGroup>`. Render keyed items in its slot: neighbors spring to their new place, a new item grows from `origin` (the row it duplicates) or from its slot, and a removed item folds away.
- `Progress` shows work that runs: `value` from 0 to 1 fills the bar with a head, `null` shows a wave while the total is not known, and `done` draws a dot into a check. It has `role="progressbar"` and `aria-valuenow`.
- `DropField` is a label around a file input. The dots behind its text lean toward a dragged file. A click and the keyboard open the file picker. It emits `files`.
- `HoldToDelete` is a button that deletes when it is held. It emits `delete` (hide the item), shows Undo for `undoFor` ms (emits `undo`), and only then calls `commit`. Unmounting it during the Undo window commits. A click from a screen reader asks `confirm` first.

```vue
<MotionList tag="ul">
  <li v-for="file in files" :key="file.id">{{ file.name }}</li>
</MotionList>
<Progress :value="upload.progress" :done="upload.done" label="Upload cover.png" />
<HoldToDelete :commit="() => removeFile(file.id)" @delete="hidden = true" @undo="hidden = false" />
```

Without Vue, `createMotionList`, `createProgress`, `createDropField`, and `createHoldToDelete` from `@vite-hub/ui/motion` do the same on any element.

### Labels, icons, counts, and rings

The layer also morphs what changes with state. When the label of a `UButton` changes, such as `:label="loading ? 'Publishing' : 'Publish'"`, its letters change one at a time and the button's width follows with a spring. When Vue draws another icon into the button's leading or trailing icon, such as the spinner of `loading`, the old icon blurs out and the spinner draws its stroke in. The app only changes the label and the icon. With `@nuxt/icon` in CSS mode an icon is a class, which the layer does not watch, so the icon changes at once there; use `SwapIcon` in the button's `leading` slot.

For everything else, use the component or the helper:

| Vue | Helper in `@vite-hub/ui/motion` | Use it for |
| --- | --- | --- |
| `<MorphText :text="copied ? 'Copied' : 'Copy link'" />` | `morphText(element, text)` | A label outside a `UButton` |
| `<SwapIcon :name="icon" enter="draw" />` | `swapIcon(container, icon, { exit, enter })` | An icon that says what happened: `exit: "right"` for an arrow that leaves the way it points, `enter: "draw"` for a check or a spinner |
| `<RollNumber :value="count" />` | `rollNumber(element, value, format?)` | A count: only the changed digits roll, up when it grows, down when it shrinks |
| `<UButton v-ring="saved" />` | `ring(element)` | A finished action, such as saved or copied: a ring in the border color grows once and fades. A button joined to others in a `UFieldGroup` rings the whole group |

`CopyButton` uses all of them. Each helper can be called again in the middle of its motion and continues from where it is. The element keeps the final text for screen readers the whole time and holds plain text again at the end. Under reduced motion a label, an icon, or a digit crossfades in 150ms, and there is no ring. Inside `data-motion="none"` the change happens at once.

The entry also has the spring engine (`createSpring`, `springs.snappy`, `springs.soft`), reduced motion (`prefersReducedMotion`, `onReducedMotionChange`, `forceReducedMotion`), `setMotionSlowFactor(4)` to watch an effect at ¼×, and `defineMotionEffect` to add an effect for a role. The motion page in `test/browser/motion/` renders every role; `pnpm --filter @vite-hub/ui test:motion` checks it in Chromium, and `MOTION_RECORD=<dir>` records each press at ¼×.

## Components that the parts render

The styled parts render a few components by name: `UButton`, `UIcon`, `UInput`, `UModal`, `UTabs`, `UDropdownMenu`, `UTooltip`, and the editor parts `UEditorToolbar`, `UEditorSuggestionMenu`, and `UEditorDragHandle`. By default they render the ui-sdk ones of `uiSdkComponents`, built on [ui-sdk](https://ui-sdk.dev) and styled by the `@vite-hub/kit` style family. Each one loads on first render, so a page without these parts loads no ui-sdk component.

A part uses the component given to `createViteHubUI({ components })` first, then a global one with the same name from `app.component()`, then the ui-sdk one. An app that keeps Nuxt UI gives Nuxt UI's:

```ts
// src/main.ts
import NuxtUI from "@nuxt/ui/vue-plugin";
import UButton from "@nuxt/ui/components/Button.vue";
import UModal from "@nuxt/ui/components/Modal.vue";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import { createViteHubUI } from "@vite-hub/ui";
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).use(NuxtUI).use(createViteHubUI({ components: { UButton, UModal, UTooltip } })).mount("#app");
```

The Console and the docs do this until they move off Nuxt UI (vite-hub/vitehub#5258). A name that the app does not give still renders the ui-sdk component.

- There is no ui-sdk `UTooltip`. Without one, a part puts the text in the `title` attribute. Nuxt UI's `UTooltip` needs `UApp` around the page.
- `UIcon` draws the Lucide icons that the parts use. To show other names, such as your own in `createViteHubUI({ icons })`, give your own `UIcon` too.
- The buttons and fields keep the kit's `data-slot` (`button`, `input`), so a part's own name moves to `data-part`, for example `data-part="copy-button"`.
- The set also replaces the editor parts of `MarkdownEditor`: `UEditorToolbar` on ui-sdk's `Toolbar` and `Toggle`, which says the pressed state with `aria-pressed`, `UEditorSuggestionMenu` on ui-sdk's `TriggerMenu`, a listbox at the caret while focus stays in the editor, and `UEditorDragHandle` on Tiptap's drag handle. They take the props, slots, and events of Nuxt UI's.
- In the "/" menu, Escape closes the list until the trigger is typed again or Control+Space reopens it, and a disabled item can be highlighted but not chosen, as the listbox pattern asks.

`pnpm --filter @vite-hub/ui test:ui-sdk` renders every part that uses these names with the set and drives each one with the keyboard. `pnpm --filter @vite-hub/ui test:editor` drives the editor parts with the keyboard and the pointer, with Nuxt UI's parts and with the set.

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
- The styled components render ui-sdk components unless the app gives others. `@vite-hub/ui/styles.css` adds ViteHub presentation but is not a replacement for Tailwind and a style family, such as the `@vite-hub/kit` styles, or the Nuxt UI imports.
- The package supplies accessible defaults for its message log, prompt, scroll controls, lists, and built-in actions. The application remains responsible for accessible names on custom controls and slots, meaningful status and error copy, focus behavior around application-owned navigation, and testing the completed interface.
- `FileTree` names its search input **Search files** by default. Pass `search-label` for a localized or context-specific accessible name.
- The headless entry point owns scrolling behavior, not appearance. Importing `@vite-hub/ui/headless` does not load the stylesheet or any component set.

## Documentation

- [AI components overview and layer ownership](https://vitehub.dev/docs/ui/ai-components)
- [Installation and package defaults](https://vitehub.dev/docs/ui/installation)
- [Icons](https://vitehub.dev/docs/ui/installation#icons): the parts read Nuxt UI's `appConfig.ui.icons` and, for names Nuxt UI does not have, `appConfig.viteHubUI.icons`
- [Chat and transport boundary](https://vitehub.dev/docs/ui/chat)
- [Prompt input](https://vitehub.dev/docs/ui/prompt-input) and [attachments](https://vitehub.dev/docs/ui/attachments)
- [Headless message scroller](https://vitehub.dev/docs/ui/message-scroller)
- [Comments](https://vitehub.dev/docs/ui/comments): Figma-style pins, threads, and a side list, built on [`@vite-hub/comments`](https://github.com/vite-hub/vitehub/tree/main/packages/comments)
- [Diff](https://vitehub.dev/docs/ui/diff) and [file-tree views](https://vitehub.dev/docs/ui/file-tree)

## Console views

The Agent Invocation list, view, inspector, timeline, and Capability inspector render ViteHub runtime records, so they live in the Console in `vite-hub`. Import `AgentInvocationList`, `AgentInvocation`, `AgentInvocationInspector`, and `AgentCapabilityInspector` from `vite-hub/console/ui`. Build an application-owned inspection page from the parts, such as `Trace` and `CodeBlock`, and from `ToolList`, which also documents Capability tool contracts. `ToolList` emits `select` with the tool name when a viewer chooses one. The model maker and provider marks of the Console come from [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT).
