---
title: Diff
description: "Render unified patches, file comparisons, parsed diffs, and merge conflicts with Pierre."
navigation.order: 37
navigation.group: Agent work
icon: i-lucide-file-code
---

The diff components wrap Pierre's `@pierre/diffs` views for Vue. Use them to review the changes an Agent made. Pierre parses, highlights, selects, and renders. The look follows your Nuxt UI theme.

::example{name="PatchDiffExample" height=18}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the components. In Vue with Vite, import them from `@vite-hub/ui`:

```ts
import { FileDiff, MultiFileDiff, PatchDiff, UnresolvedFile } from "@vite-hub/ui";
```

[Helpers](#helpers) and types come from `@vite-hub/ui`.

## Usage

```ts
import { PatchDiff } from "@vite-hub/ui";
```

```vue
<template>
  <PatchDiff :patch="patch" />
</template>
```

Pick the component that matches your input:

| Component        | Input                                   | Use it when                                          |
| ---------------- | --------------------------------------- | ---------------------------------------------------- |
| `PatchDiff`      | A unified patch string                  | `git diff` output for one file. |
| `MultiFileDiff`  | Two `FileContents` values               | The old and new file contents. |
| `FileDiff`       | Parsed `FileDiffMetadata`               | A parsed patch, or partial diffs to hydrate. |
| `UnresolvedFile` | A `FileContents` with conflict markers  | A merge conflict with resolution controls. |

## Features

- Four views: a unified patch, two file versions, a parsed diff, and a merge conflict.
- The theme follows Nuxt UI backgrounds, borders, radius, typography, and semantic colors.
- Syntax highlighting loads only when a code view first renders.
- Split and unified layouts with `options.diffStyle`.
- `selectedLines` highlights a range from app state, and `scrollToSelectedLines` scrolls to it.

## Compare Two Files

For an added or deleted file, pass `null` for the missing side. Set `options.diffStyle` to `'split'` or `'unified'`.

::example{name="MultiFileDiffExample" height=24}
::

## Parsed Diffs

Parse a multi-file patch once with `parsePatchFiles()`, then render each file.

::example{name="FileDiffExample" height=24}
::

## Merge Conflict

`UnresolvedFile` shows conflict markers with controls to resolve each one.

::example{name="UnresolvedFileExample" height=8}
::

## Helpers

The package re-exports Pierre's `getSingularPatch`, `parseDiffFromFile`, and `parsePatchFiles`, and the types `FileContents`, `FileDiffMetadata`, `FileDiffOptions`, `DiffLineAnnotation`, `SelectedLineRange`, and `UnresolvedFileOptions`.

## Styling

The default theme maps Pierre's CSS properties to Nuxt UI's `--ui-*` properties. Override a ViteHub property on one view for a different look:

```css
.review-diff {
  --vh-ui-bg: var(--ui-bg-elevated);
  --vh-ui-success: var(--ui-primary);
}
```

Pass Pierre's `theme` option for other syntax colors. Backgrounds and diff colors still follow the app theme.

## Accessibility

- ViteHub turns off pointer line selection. Set `selectedLines` to highlight a range from app state.
- Unchanged lines are always expanded, so no context hides in collapsed hunks.
- Keep Pierre's file header, or add a heading, so readers know which file changed.

## API Reference

The components take Pierre's options and annotations. See the Pierre types for option fields. Other attributes go to the Pierre view.

### PatchDiff

Renders one file from a unified patch.

#### Props

| Prop              | Type                                 | Default  | Description                                    |
| ----------------- | ------------------------------------ | -------- | ---------------------------------------------- |
| `patch`           | `string`                             | Required | A one-file unified patch. |
| `options`         | `FileDiffOptions`                    |          | Layout, themes, headers, interactions, hydration. |
| `lineAnnotations` | `DiffLineAnnotation[]`               |          | Your line content. |
| `selectedLines`   | `SelectedLineRange \| null`          |          | Selected line range. Controlled when set. |
| `scrollToSelectedLines` | `boolean`                      | `false`  | Scrolls to `selectedLines` for each new diff or range. |

### MultiFileDiff

Renders the diff between two versions of one file.

#### Props

| Prop              | Type                                 | Default  | Description                                    |
| ----------------- | ------------------------------------ | -------- | ---------------------------------------------- |
| `oldFile`         | `FileContents \| null`               | Required | Old file, `null` if added. |
| `newFile`         | `FileContents \| null`               | Required | New file, `null` if deleted. |
| `options`         | `FileDiffOptions`                    |          | Layout, themes, headers, interactions, hydration. |
| `lineAnnotations` | `DiffLineAnnotation[]`               |          | Your line content. |
| `selectedLines`   | `SelectedLineRange \| null`          |          | Selected line range. Controlled when set. |
| `scrollToSelectedLines` | `boolean`                      | `false`  | Scrolls to `selectedLines` for each new diff or range. |

### FileDiff

Renders one file from parsed diff metadata.

#### Props

| Prop              | Type                                 | Default  | Description                                    |
| ----------------- | ------------------------------------ | -------- | ---------------------------------------------- |
| `fileDiff`        | `FileDiffMetadata`                   | Required | A parsed file diff.                            |
| `options`         | `FileDiffOptions`                    |          | Layout, themes, headers, interactions, hydration. |
| `lineAnnotations` | `DiffLineAnnotation[]`               |          | Your line content. |
| `selectedLines`   | `SelectedLineRange \| null`          |          | Selected line range. Controlled when set. |
| `scrollToSelectedLines` | `boolean`                      | `false`  | Scrolls to `selectedLines` for each new diff or range. |

### UnresolvedFile

Renders merge conflict markers with resolution controls.

#### Props

| Prop              | Type                                 | Default  | Description                                    |
| ----------------- | ------------------------------------ | -------- | ---------------------------------------------- |
| `file`            | `FileContents`                       | Required | A file with conflict markers.                  |
| `options`         | `UnresolvedFileOptions`              |          | Pierre options for the conflict view.          |
| `lineAnnotations` | `DiffLineAnnotation[]`               |          | Your line content. |
| `selectedLines`   | `SelectedLineRange \| null`          |          | Selected line range. Controlled when set. |
| `scrollToSelectedLines` | `boolean`                      | `false`  | Scrolls to `selectedLines` for each new diff or range. |

## Related

- [Code view](/docs/ui/code-view) renders full files and mixed file and diff lists.
- [File tree](/docs/ui/file-tree) selects which file to review.
- [Code review block](/docs/ui/blocks/code-review) combines a tree, a diff, and a trace.
