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

### FileView

Renders one syntax-highlighted file.

#### Props

| Prop              | Type                                | Default  | Description                                  |
| ----------------- | ----------------------------------- | -------- | -------------------------------------------- |
| `file`            | `FileContents`                      | Required | The file name and contents.                  |
| `options`         | `FileOptions`                       |          | Pierre options for the file view.            |
| `lineAnnotations` | `LineAnnotation[]`                  |          | Your line content. |
| `selectedLines`   | `SelectedLineRange \| null`         |          | Selected line range. Controlled when set. |

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
