---
title: Code View
description: "Render syntax-highlighted files, and virtualized lists that mix files and diffs."
navigation.order: 38
navigation.group: Agent work
icon: i-lucide-code
---

`CodeView` renders files and diffs in order in one virtualized scroll container (only visible rows render). `FileView` renders one highlighted file without a diff. Both use Pierre's `@pierre/diffs` views with the Nuxt UI theme. Use them to show the files an Agent read or wrote next to its changes.

::example{name="CodeViewExample" height=24}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the components. In Vue with Vite, import them from `@vite-hub/ui`:

```ts
import { CodeView, FileView } from "@vite-hub/ui";
```

Helpers and types, such as `getSingularPatch` and `FileContents`, come from `@vite-hub/ui`.

## Usage

```ts
import { CodeView, getSingularPatch, type CodeViewItem } from "@vite-hub/ui";
```

```vue
<template>
  <CodeView class="h-[32rem]" :items="items" />
</template>
```

Give `CodeView` a height. It scrolls inside it.

Each item has an `id` and a `type`. A `file` item has a `file: FileContents`. A `diff` item has a `fileDiff: FileDiffMetadata`, such as from `getSingularPatch(patch)`.

## Features

- Pierre parses, highlights, and renders. ViteHub applies the Nuxt UI theme.
- Syntax highlighting loads only when a code view first renders.

## One File

`FileView` renders one file. Set `selectedLines` to highlight a range from app state.

::example{name="FileExample" height=20}
::

## Open a File at Its Lines

A link such as `?file=server/api/orders.get.ts&line=3-5` must select the file in the tree, highlight the lines, and scroll to them. Keep the file and the lines in your app state. [`FileTree`](/docs/ui/file-tree#selected-file) takes the file with `v-model:selected-path`. With `scroll-to-selected-lines`, the view scrolls to `selectedLines` one time for each new file or range. It scrolls only the nearest container that scrolls, so the page around the view stays in place. The [diff](/docs/ui/diff) components and `CodeView` have the same prop.

```vue
<script setup lang="ts">
import type { SelectedLineRange } from "@vite-hub/ui";

const props = defineProps<{ files: Record<string, string> }>();
const route = useRoute();
const router = useRouter();

const path = computed({
  get: () => (typeof route.query.file === "string" ? route.query.file : undefined),
  // A file that the reader selects has no lines.
  set: (file) => router.replace({ query: { file } }),
});
const lines = computed<SelectedLineRange | null>(() => {
  const [start, end = start] = String(route.query.line ?? "").split("-").map(Number);
  return start && end ? { start, end } : null;
});
</script>

<template>
  <FileTree v-model:selected-path="path" :paths="Object.keys(files)" />
  <FileView
    v-if="path && path in files"
    :file="{ name: path, contents: files[path]! }"
    :selected-lines="lines"
    scroll-to-selected-lines
  />
</template>
```

The components do not read the URL. The same props work with a route query, a hash, or a store.

## Accessibility

- ViteHub turns off pointer line selection. Set `selectedLines` to highlight lines from app state.
- Keep the file header, or add a heading, so readers know which file they read.

## API Reference

### CodeView

Renders a virtualized list of files and diffs.

#### Props

| Prop            | Type                                  | Default  | Description                                    |
| --------------- | ------------------------------------- | -------- | ---------------------------------------------- |
| `items`         | `readonly CodeViewItem[]`             | Required | Files and diffs, in order. |
| `options`       | `CodeViewOptions`                     |          | Pierre options for the list.                   |
| `selectedLines` | `CodeViewLineSelection \| null`       |          | Selected lines. Controlled when set. |
| `scrollToSelectedLines` | `boolean`                     | `false`  | Scrolls to each new `selectedLines`. |

### FileView

Renders one syntax-highlighted file.

#### Props

| Prop              | Type                                | Default  | Description                                  |
| ----------------- | ----------------------------------- | -------- | -------------------------------------------- |
| `file`            | `FileContents`                      | Required | The file name and contents.                  |
| `options`         | `FileOptions`                       |          | Pierre options for the file view.            |
| `lineAnnotations` | `LineAnnotation[]`                  |          | Your line content. |
| `selectedLines`   | `SelectedLineRange \| null`         |          | Selected line range. Controlled when set. |
| `scrollToSelectedLines` | `boolean`                     | `false`  | Scrolls to `selectedLines` for each new file or range. |

Other attributes go to the Pierre view.

#### Types

`CodeViewItem`, `CodeViewOptions`, `CodeViewLineSelection`, `FileContents`, `FileOptions`, `LineAnnotation`, and `SelectedLineRange` are re-exported from `@pierre/diffs`.

```ts fragment
interface FileContents {
  /** Shown in the header. Also selects the syntax highlighting language. */
  name: string;
  contents: string;
  /** Sets the language instead of inferring it from the name. */
  lang?: SupportedLanguages;
  header?: string;
  cacheKey?: string;
}
```

## Related

- [Diff](/docs/ui/diff) renders patches and file comparisons.
- [File tree](/docs/ui/file-tree) selects which file to show.
