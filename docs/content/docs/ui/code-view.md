---
title: Code View
description: "Render syntax-highlighted files, and virtualized lists that mix files and diffs."
navigation.order: 38
navigation.group: Agent work
icon: i-ph-code-light
---

`CodeView` renders a virtualized list of files and diffs in one scroll container. `FileView` renders one syntax-highlighted file without a diff. Both use Pierre's `@pierre/diffs` views with the Nuxt UI theme. Use them to show the files an Agent read or produced next to the changes it made.

::component-preview{name="CodeViewExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the components. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entries `@vite-hub/ui/code-view` and `@vite-hub/ui/file-view`:

```ts
import { CodeView, FileView } from "@vite-hub/ui";
```

The helpers and types, such as `getSingularPatch` and `FileContents`, come from `@vite-hub/ui`.

## Usage

```ts
import { CodeView, getSingularPatch, type CodeViewItem } from "@vite-hub/ui";
```

```vue
<template>
  <CodeView class="h-[32rem]" :items="items" />
</template>
```

Give `CodeView` a height. It owns the scrolling inside that height.

Each item has an `id` and a `type`. A `file` item has a `file: FileContents`. A `diff` item has a `fileDiff: FileDiffMetadata`, for example from `getSingularPatch(patch)`.

## Features

- `CodeView` renders files and diffs in order in one virtualized scroll container.
- `FileView` renders one file without a diff.
- Pierre's `@pierre/diffs` owns parsing, syntax highlighting, and rendering. ViteHub applies the Nuxt UI theme.
- Syntax highlighting loads only when a code view first renders.
- `selectedLines` highlights lines from application state.

## One File

`FileView` renders one file. Set `selectedLines` to highlight a range from application state.

::component-preview{name="FileExample"}
::

## Accessibility

- ViteHub turns off pointer line selection. Set `selectedLines` to highlight lines from application state.
- Keep the file header visible, or add a heading, so readers know which file they read.

## API Reference

### CodeView

Renders a virtualized list of files and diffs.

#### Props

| Prop            | Type                                  | Default  | Description                                    |
| --------------- | ------------------------------------- | -------- | ---------------------------------------------- |
| `items`         | `readonly CodeViewItem[]`             | Required | Files and diffs to render, in order.           |
| `options`       | `CodeViewOptions`                     |          | Pierre options for the list.                   |
| `selectedLines` | `CodeViewLineSelection \| null`       |          | The selected lines. Controlled when set.       |

### FileView

Renders one syntax-highlighted file.

#### Props

| Prop              | Type                                | Default  | Description                                  |
| ----------------- | ----------------------------------- | -------- | -------------------------------------------- |
| `file`            | `FileContents`                      | Required | The file name and contents.                  |
| `options`         | `FileOptions`                       |          | Pierre options for the file view.            |
| `lineAnnotations` | `LineAnnotation[]`                  |          | Application content on lines.                |
| `selectedLines`   | `SelectedLineRange \| null`         |          | The selected line range. Controlled when set. |

Other attributes go to the Pierre view.

#### Types

`CodeViewItem`, `CodeViewOptions`, `CodeViewLineSelection`, `FileContents`, `FileOptions`, `LineAnnotation`, and `SelectedLineRange` are re-exported from `@pierre/diffs`.

```ts
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
