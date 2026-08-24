---
title: Diff
description: Render a unified patch or a parsed Pierre file diff inside a Vue application.
navigation.order: 34
navigation.group: Agent work
icon: i-ph-file-code-light
---

`AgentDiff` is the Vue lifecycle adapter for `@pierre/diffs`. Pass a patch for the direct path, or pass a parsed `FileDiffMetadata` when the application already owns diff parsing and configuration.

::component-preview{name="DiffExample"}
::

## Usage

Render a unified patch:

```vue
<AgentDiff :patch="patch" />
```

Use `fileDiff` for a pre-parsed diff and `options` for Pierre behavior such as split view, line selection, and themes:

```vue
<AgentDiff
  :file-diff="fileDiff"
  :options="{
    diffStyle: 'split',
    theme: { dark: 'pierre-dark', light: 'pierre-light' },
  }"
/>
```

## Props

| Prop            | Type                        | Purpose                                   |
| --------------- | --------------------------- | ----------------------------------------- |
| `patch`         | `string`                    | Unified patch text.                       |
| `fileDiff`      | `FileDiffMetadata`          | A diff already parsed by Pierre.          |
| `options`       | `FileDiffOptions`           | Pierre rendering and interaction options. |
| `selectedLines` | `SelectedLineRange \| null` | Controlled line selection.                |

Pass either `patch` or `fileDiff`. The component forwards HTML attributes to the diff host and updates the Pierre renderer when its inputs change.

## Ownership

Pierre owns parsing, syntax highlighting, selection, and diff presentation. ViteHub owns the Vue mount, update, and cleanup boundary. This keeps the public data model compatible with Pierre instead of introducing a second ViteHub diff schema.
