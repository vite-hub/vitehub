---
title: Code View
description: "Render syntax-highlighted files, and virtualized lists that mix files and diffs."
navigation.order: 38
navigation.group: Agent work
icon: i-ph-code-light
---

`AgentCodeView` renders a virtualized list of files and diffs in one scroll container. `AgentFile` renders one syntax-highlighted file without a diff. Both use Pierre's `@pierre/diffs` views with the Nuxt UI theme. Use them to show the files an Agent read or produced next to the changes it made.

::component-preview{name="CodeViewExample"}
::

## Usage

Give `AgentCodeView` a height. It owns the scrolling inside that height.

```vue
<AgentCodeView class="h-[32rem]" :items="items" />
```

Each item has an `id` and a `type`. A `file` item has a `file: FileContents`. A `diff` item has a `fileDiff: FileDiffMetadata`, for example from `getSingularPatch(patch)`.

## Examples

### One file

`AgentFile` renders one file. Set `selectedLines` to highlight a range from application state.

::component-preview{name="FileExample"}
::

## API reference

### AgentCodeView

#### Props

| Prop            | Type                                  | Default  | Description                                    |
| --------------- | ------------------------------------- | -------- | ---------------------------------------------- |
| `items`         | `readonly CodeViewItem[]`             | Required | Files and diffs to render, in order.           |
| `options`       | `CodeViewOptions`                     |          | Pierre options for the list.                   |
| `selectedLines` | `CodeViewLineSelection \| null`       |          | The selected lines. Controlled when set.       |

### AgentFile

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

## Accessibility

- ViteHub turns off pointer line selection. Set `selectedLines` to highlight lines from application state.
- Keep the file header visible, or add a heading, so readers know which file they read.

## Related

- [Diff](/docs/ui/diff) renders patches and file comparisons.
- [File tree](/docs/ui/file-tree) selects which file to show.
