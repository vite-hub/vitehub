---
title: Workspace
description: "A complete workspace for playgrounds and lessons: the bar, the files, the editor, and the output of a WebContainer app or of a render function."
navigation.order: 46
navigation.group: Agent work
icon: i-lucide-square-play
---

`Workspace` puts the workspace parts together: the bar, the examples menu, the sidebar, the start screen, the file tree, the editor, the status line, the output, and with `steps` the guide of a lesson. A runner runs the files. `webContainer()` runs an app with a dev server in the browser. `render()` renders the files to a page with your function. The workspace tracks edits, asks before it discards them, copies share links, and downloads zips.

::example{name="WorkspaceRenderExample" height=28}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). Import `Workspace` and the runners from the workspace entry:

```ts
import { render, useWorkspace, useWorkspaceDevice, webContainer, Workspace } from "vite-hub/ui/workspace";
```

The entry loads CodeMirror and xterm only when a workspace shows them, and it is the only entry that imports `@vite-hub/web-container`.

## Usage

### Run an app in a WebContainer

`webContainer()` mounts the files of the example in a WebContainer, installs the dependencies, and runs `npm run dev`. The output has a Preview tab for the dev server on `port` and a Terminal tab. With `connect`, a Connect tab signs in to the providers of `defineConnect()`.

::example{name="WorkspaceExample" height=28}
::

```vue
<script setup lang="ts">
import { webContainer, Workspace, type WorkspaceExample } from "vite-hub/ui/workspace";

const examples: WorkspaceExample[] = [
  { id: "kv", label: "KV", group: "Primitives", files: kvFiles, open: "server/routes/index.ts" },
  { id: "blob", label: "Blob", group: "Primitives", files: blobFiles },
];

const runner = webContainer({ port: 3000, snapshot: example => snapshots[example.id] });
</script>

<template>
  <Workspace :examples :runner name="vitehub" start class="h-[70vh]" />
</template>
```

A WebContainer needs a cross-origin isolated page. A browser that cannot run it shows a notice with Download. Only desktops start the runner on their own. A tablet shows an Open button, and a phone shows a card with Copy link and Download. Use the `intro` and `fallback` slots to add text around these cards.

`snapshot(example)` gives a loader of the `node_modules` of an example. Examples with the same loader and the same `package.json` share one run, so a switch between them only writes the files. Another example boots a new run. One runner boots one WebContainer at a time, so a fast switch waits for the boot before it.

### Render the files in the page

`render(fn)` runs your function 200 ms after the last edit, as `fn(files, { example })`. It returns `{ html, issues? }`, where an issue is `{ message, file?, line? }`. An issue with a `file` shows `file:line`, and a click on it opens that file. The output has an Output tab with the HTML in a sandboxed frame, and an Issues tab. A thrown error shows as an issue, and a result for older files never replaces a newer one. Every device can run it.

```vue
<script setup lang="ts">
import { render, Workspace } from "vite-hub/ui/workspace";
import { marked } from "marked";

const examples = [{ id: "hello", label: "Hello", files: { "content.md": "# Hello\n" } }];

const runner = render(async files => ({ html: await marked.parse(files["content.md"] ?? "") }), {
  document: html => `<!doctype html><link rel="stylesheet" href="/prose.css"><body>${html}</body>`,
});
</script>

<template>
  <Workspace :examples :runner name="markdown" class="h-[70vh]" />
</template>
```

### Read-only and binary files

List paths in `readonly` to lock them. The editor refuses typing in them and its head shows **Read-only**. `setFile` still writes them, so a lesson can change them. Put binary files in `assets`. The tree and the editor never show them. `webContainer()` mounts them next to the files, and `render()` gives them to your function through `example`.

```ts
import { render, type WorkspaceExample } from "vite-hub/ui/workspace";

const examples: WorkspaceExample[] = [{
  id: "model",
  label: "Model",
  files: { "index.html": "<h1>Model</h1>\n", "footer.html": "<footer>Shared footer</footer>" },
  readonly: ["footer.html"],
  assets: { "weights.bin": new Uint8Array([1, 2, 3]) },
}];

const runner = render(async (files, { example }) => {
  const weights = example.assets?.["weights.bin"];
  const issues = weights ? [] : [{ message: "weights.bin is missing.", file: "index.html", line: 1 }];
  return { html: `${files["index.html"]}${files["footer.html"]}`, issues };
});
```

### Lessons

Give `steps` to show the steps menu in the bar and the guide next to the code. `guide="top"` puts the guide over the code, and `guide="side"` puts it in a column. Put the text of the current step in the `guide` slot.

```vue
<template>
  <Workspace v-model:step="step" :examples :runner :steps guide="side" :share="false">
    <template #guide>
      <ContentRenderer :value="pages[step]" />
    </template>
  </Workspace>
</template>
```

### Read and change the files

`useWorkspace()` returns the workspace around the calling component. Call it in a slot of `Workspace`. The slots also get the same values as props.

```ts fragment
const { files, setFile, edited, show, showTab, guard } = useWorkspace();

setFile("locales/de.json", solution);
show("locales/de.json");
showTab("terminal");
guard("Replace your code with the solution?", "Solve", () => setFile("app.vue", solution));
```

`edited` lists the paths that differ from the open example. `guard(title, confirm, action)` runs `action` at once when nothing is edited. Otherwise it asks first in a dialog, with `title` as the question and `confirm` on the button.

### Place the workspace

`useWorkspaceDevice(runner)` tells the page where it runs, after mount. Use it to place a workspace next to a lesson on a desktop and under it on a phone.

```ts fragment
const { device, supported } = useWorkspaceDevice(runner);
// device: "pending" | "phone" | "tablet" | "desktop"
```

### Share links

With `share`, Copy link puts the files in the URL hash as `#code=…`, with the example id as `template`. Opening the link restores those files on their example and shows a notice. Download saves a zip named after `name` and the example id, such as `vitehub-kv.zip`.

### Sidebar

With a `sidebar` slot, the bar shows a sidebar button. Reset, Download, and Copy link move to the bottom of the sidebar.

## Accessibility

The workspace is a region named by `label`. The bar, the editor, the tabs, and the menus use the parts of [Workspace bar](/docs/ui/workspace-bar) and [Workspace code](/docs/ui/workspace-code). While the start screen shows, only the bar and the example cards are in the page. After a pick, focus moves to the bar. Reset and every action of `guard` ask first in a dialog when files are edited. The render output runs in a sandboxed frame with its own origin, so a shared link cannot reach your page.

## API Reference

### Workspace

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `examples` | `WorkspaceExample[]` | Required | The examples, each `{ id, label, files, group?, description?, open?, preview?, readonly?, assets? }`. `readonly` lists paths the editor locks. `assets` holds binary files by path. More than one shows an examples menu. |
| `runner` | `WorkspaceRunner` | Required | Runs the files: `webContainer()` or `render()`. |
| `example` | `string` | | The id of the open example, such as from `?example=`. Defaults to the first example. Use `v-model:example`. |
| `selected` | `string` | | The file in the editor. Use `v-model:selected`. |
| `steps` | `WorkspaceStep[]` | `[]` | The steps of a lesson, each `{ title, description? }`. They add the guide and the steps menu. |
| `step` | `number` | | The current step, from 0. Use `v-model:step`. |
| `guide` | `"top" \| "side"` | | Where the guide goes: `top` over the code, or `side` in a column. Without steps, `side` puts the output over the code. |
| `tabs` | `WorkspaceTabItem[]` | `[]` | More output tabs, after the tabs of the runner. Each one shows the slot with the name of its `value`. |
| `share` | `boolean` | `true` | Copy link and Download, and opening `#code=` links. |
| `name` | `string` | `""` | The start of the zip name. The example id follows it. |
| `start` | `boolean` | `false` | Shows the examples as cards on a first visit, before any run starts or any snapshot loads. A share link skips them. |
| `label` | `string` | `"workspace"` | What the reader calls this, in lowercase, such as `"playground"`. It names the region, the Open button, and the notices. |
| `open` | `boolean` | `false` | Whether the workspace shows, for a runner that only desktops start. Set it to `true` to show it on a tablet. Use `v-model:open`. |

#### Events

| Event | Payload | Description |
| --- | --- | --- |
| `update:example` | `string` | The reader opened an example, or discarded the changes to one. |
| `update:selected` | `string` | The reader opened another file. |
| `update:step` | `number` | The reader moved to another step. |
| `update:open` | `boolean` | The workspace showed or hid. |

#### Slots

| Slot | Props | Description |
| --- | --- | --- |
| `bar-lead` | `WorkspaceSlotProps` | Controls at the start of the bar, after the examples menu. |
| `bar-actions` | `WorkspaceSlotProps` | Controls at the end of the bar, before Reset. |
| `sidebar` | `WorkspaceSlotProps` | The content of the sidebar, such as links to the docs. |
| `guide` | `WorkspaceSlotProps` | The text of the current step. |
| `banner` | `WorkspaceSlotProps` | A notice under the bar. |
| `intro` | | Text before the card that a device which does not start the runner shows. |
| `fallback` | | Content after that card, such as links to the examples. |
| The `value` of a tab | `WorkspaceSlotProps` | The panel of a tab of `tabs`. |

### webContainer

`webContainer(options?)` returns a `WebContainerRunner`. Its `workspace` ref is the WebContainer of the current run, for code outside the workspace.

| Option | Type | Description |
| --- | --- | --- |
| `port` | `number` | The port of the dev server. Other servers do not become the preview. |
| `snapshot` | `(example) => (() => Promise<Uint8Array \| ArrayBuffer>) \| undefined` | The `node_modules` snapshot of an example. Without one, the runner runs `npm install`. |
| `connect` | `Connect` | The providers of `defineConnect()`. Their tokens reach the dev server as environment variables. |

### render

`render(fn, options?)` returns a `WorkspaceRunner`.

| Option | Type | Description |
| --- | --- | --- |
| `fn` | `(files, { example }) => Promise<{ html, issues? }>` | Renders the files. `example` is the open example, with its `assets`. An issue is `{ message, file?, line? }`. |
| `document` | `(html, files) => string` | Wraps the HTML in the page of the output, with your stylesheets and theme. Defaults to a plain page. |

## Related

- [Workspace bar](/docs/ui/workspace-bar)
- [Workspace code](/docs/ui/workspace-code)
- [Workspace guide](/docs/ui/workspace-guide)
