---
title: Playground Render
description: "Edit files and see them render in the page, such as Markdown or JSON, with examples, issues, and share links."
navigation.order: 46
navigation.group: Agent work
icon: i-lucide-square-play
---

`PlaygroundRender` is a playground for code that renders in the browser. It needs no WebContainer. You give it a `render` function, the editor panes, and the examples. It shows the editors, the examples, the issues, and the preview.

::example{name="PlaygroundRenderExample" height=28}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports `PlaygroundRender`. In Vue with Vite, import it from `@vite-hub/ui`:

```ts
import { PlaygroundRender } from "@vite-hub/ui";
```

## Usage

```vue
<script setup lang="ts">
import type { PlaygroundFiles } from "@vite-hub/ui";
import { marked } from "marked";

const presets = [{ id: "hello", label: "Hello", files: { "content.md": "# Hello\n" } }];
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

Each edit renders 200 ms after the last key, and a render that ends after a newer one is dropped. The URL hash holds the files as a share link, with the open example as its template. `render(files)` returns `{ html, issues? }`, where an issue is `{ message, line? }`. A thrown error shows as an issue.

## Accessibility

The examples are a list of buttons, and the open one has `aria-current`. The file tabs are a group of toggle buttons. Each editor is a text area named by the label of its pane. Reset asks first in a dialog. The preview runs in a sandboxed frame with its own origin, so a shared link cannot reach your page.

## API Reference

### PlaygroundRender

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `presets` | `PlaygroundPreset[]` | Required | The examples, each `{ id, label, files, group? }`. A share link names one of them as its template. |
| `preset` | `string` | | The id of the example that opens when the URL has no link. Without it, the first preset opens. |
| `panes` | `PlaygroundPane[]` | Required | The editor tabs, each `{ file, label, language?, slot? }`. A pane with `slot` shows that slot in place of the editor. |
| `render` | `(files) => Promise<PlaygroundResult>` | Required | Renders the files to `{ html, issues? }`. |
| `languages` | `LanguageInput[]` | | Shiki languages for the panes. They load after the first render. Without them, the panes are plain text. |
| `previewDocument` | `(html, files) => string` | | Wraps the HTML in the preview page, with your stylesheets and theme. Without it, the preview is a plain page. |

#### Slots

| Slot | Props | Description |
| --- | --- | --- |
| `toolbar` | `{ files, preset, setFile }` | Controls in the editor bar. |
| `preset` | `{ preset, active }` | Draws one example in the list. |
| The `slot` of a pane | `{ pane, value, files, setFile }` | Replaces the editor of that pane, such as a theme form that writes `theme.json`. |

## Related

- [Device frame](/docs/ui/device-frame)
- [Copy button](/docs/ui/copy-button)
