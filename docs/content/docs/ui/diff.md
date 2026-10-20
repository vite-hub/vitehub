---
title: Diff
description: "Render unified patches, file comparisons, parsed diffs, and merge conflicts with Pierre."
navigation.order: 37
navigation.group: Agent work
icon: i-ph-file-code-light
---

The diff components are Vue adapters for Pierre's `@pierre/diffs` views. They use Nuxt UI backgrounds, borders, radius, typography, and semantic colors. Pierre owns parsing, syntax highlighting, selection, and rendering. Use them to review the changes an Agent made.

::component-preview{name="PatchDiffExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the components. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entries `@vite-hub/ui/patch-diff`, `@vite-hub/ui/multi-file-diff`, `@vite-hub/ui/file-diff`, and `@vite-hub/ui/unresolved-file`:

```ts
import { FileDiff, MultiFileDiff, PatchDiff, UnresolvedFile } from "@vite-hub/ui";
```

The [helpers](#helpers) and types come from `@vite-hub/ui`.

## Usage

```ts
import { PatchDiff } from "@vite-hub/ui";
```

```vue
<template>
  <PatchDiff :patch="patch" />
</template>
```

Pick the component that matches the input you have:

| Component        | Input                                   | Use it when                                          |
| ---------------- | --------------------------------------- | ---------------------------------------------------- |
| `PatchDiff`      | A unified patch string                  | You have `git diff` output for one file.             |
| `MultiFileDiff`  | Two `FileContents` values               | You have the old and new file contents.              |
| `FileDiff`       | Parsed `FileDiffMetadata`               | You already parsed the patch, or hydrate partial diffs. |
| `UnresolvedFile` | A `FileContents` with conflict markers  | You show a merge conflict with resolution controls.  |

## Features

- Four views: a unified patch, two file versions, a parsed diff, and a merge conflict.
- Pierre owns parsing, syntax highlighting, selection, and rendering.
- The theme follows Nuxt UI backgrounds, borders, radius, typography, and semantic colors.
- Syntax highlighting loads only when a code view first renders.
- Split and unified layouts through `options.diffStyle`.
- `selectedLines` highlights a range from application state.

## Compare Two Files

Pass `null` for the missing side of an added or deleted file. Set `options.diffStyle` to `'split'` or `'unified'`.

::component-preview{name="MultiFileDiffExample"}
::

## Parsed Diffs

Parse a multi-file patch once with `parsePatchFiles()`, then render each file from its metadata.

::component-preview{name="FileDiffExample"}
::

## Merge Conflict

`UnresolvedFile` renders conflict markers with controls to resolve each conflict.

::component-preview{name="UnresolvedFileExample"}
::

## Helpers

The package re-exports Pierre's `getSingularPatch`, `parseDiffFromFile`, and `parsePatchFiles`, and the types `FileContents`, `FileDiffMetadata`, `FileDiffOptions`, `DiffLineAnnotation`, `SelectedLineRange`, and `UnresolvedFileOptions`.

## Styling

The default theme maps Pierre's CSS properties to Nuxt UI's `--ui-*` properties. Override a ViteHub property on one view when a product needs a different look:

```css
.review-diff {
  --vh-ui-bg: var(--ui-bg-elevated);
  --vh-ui-success: var(--ui-primary);
}
```

Pass Pierre's `theme` option for different syntax token colors. Backgrounds and diff colors still follow the application theme.

## Accessibility

- ViteHub turns off pointer line selection. Set `selectedLines` to highlight a range from application state.
- Diff views always expand unchanged lines, so no context hides behind collapsed hunks.
- Keep Pierre's file header, or add your own heading, so readers know which file changed.

## API Reference

The diff components accept Pierre's options and annotations. See the Pierre types for the option fields. Other attributes go to the Pierre view.

### PatchDiff

Renders one file from a unified patch.

#### Props

| Prop              | Type                                 | Default  | Description                                    |
| ----------------- | ------------------------------------ | -------- | ---------------------------------------------- |
| `patch`           | `string`                             | Required | A unified patch for one file.                  |
| `options`         | `FileDiffOptions`                    |          | Layout, themes, headers, interactions, and hydration. |
| `lineAnnotations` | `DiffLineAnnotation[]`               |          | Application content on diff lines.             |
| `selectedLines`   | `SelectedLineRange \| null`          |          | The selected line range. Controlled when set.  |

### MultiFileDiff

Renders the diff between an old and a new version of one file.

#### Props

| Prop              | Type                                 | Default  | Description                                    |
| ----------------- | ------------------------------------ | -------- | ---------------------------------------------- |
| `oldFile`         | `FileContents \| null`               | Required | The old file. `null` for an added file.        |
| `newFile`         | `FileContents \| null`               | Required | The new file. `null` for a deleted file.       |
| `options`         | `FileDiffOptions`                    |          | Layout, themes, headers, interactions, and hydration. |
| `lineAnnotations` | `DiffLineAnnotation[]`               |          | Application content on diff lines.             |
| `selectedLines`   | `SelectedLineRange \| null`          |          | The selected line range. Controlled when set.  |

### FileDiff

Renders one file from parsed diff metadata.

#### Props

| Prop              | Type                                 | Default  | Description                                    |
| ----------------- | ------------------------------------ | -------- | ---------------------------------------------- |
| `fileDiff`        | `FileDiffMetadata`                   | Required | A parsed file diff.                            |
| `options`         | `FileDiffOptions`                    |          | Layout, themes, headers, interactions, and hydration. |
| `lineAnnotations` | `DiffLineAnnotation[]`               |          | Application content on diff lines.             |
| `selectedLines`   | `SelectedLineRange \| null`          |          | The selected line range. Controlled when set.  |

### UnresolvedFile

Renders a file with merge conflict markers and resolution controls.

#### Props

| Prop              | Type                                 | Default  | Description                                    |
| ----------------- | ------------------------------------ | -------- | ---------------------------------------------- |
| `file`            | `FileContents`                       | Required | A file with conflict markers.                  |
| `options`         | `UnresolvedFileOptions`              |          | Pierre options for the conflict view.          |
| `lineAnnotations` | `DiffLineAnnotation[]`               |          | Application content on lines.                  |
| `selectedLines`   | `SelectedLineRange \| null`          |          | The selected line range. Controlled when set.  |

## Related

- [Code view](/docs/ui/code-view) renders full files and mixed file and diff lists.
- [File tree](/docs/ui/file-tree) selects which file to review.
- [Code review block](/docs/ui/blocks/code-review) combines a tree, a diff, and a trace.
