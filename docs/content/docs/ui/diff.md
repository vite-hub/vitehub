---
title: Diff
description: Render files, patches, parsed diffs, and merge conflicts inside a Vue application.
navigation.order: 34
navigation.group: Agent work
icon: i-ph-file-code-light
---

ViteHub provides Vue lifecycle adapters for Pierre's six code and diff views. They use Nuxt UI backgrounds, borders, radius, typography, and semantic colors by default while Pierre continues to own parsing, syntax highlighting, selection, and rendering.

::component-preview{name="DiffExample"}
::

## Components

| Component | Purpose |
| --- | --- |
| `AgentCodeView` | Render a virtualized list containing files and diffs. |
| `AgentMultiFileDiff` | Compare two `FileContents` values directly. |
| `AgentPatchDiff` | Render one file change from a unified patch string. |
| `AgentFileDiff` | Render pre-parsed `FileDiffMetadata`. |
| `AgentFile` | Render one syntax-highlighted file without a diff. |
| `AgentUnresolvedFile` | Render conflict markers with resolution controls. |

Nuxt registers every component automatically. In Vue with Vite, import them from `@vite-hub/ui`.

## Usage

Render a unified patch:

```vue
<AgentPatchDiff :patch="patch" />
```

Compare two files without creating a patch first:

```vue
<AgentMultiFileDiff :old-file="before" :new-file="after" />
```

Pass `null` for the missing side of an added or deleted file.

Use a parsed diff when the application already owns parsing or partial diff hydration:

```vue
<AgentFileDiff :file-diff="fileDiff" />
```

Render a mixed virtualized view. Give the component a height so it can own scrolling:

```vue
<AgentCodeView class="h-[32rem]" :items="items" />
```

## Shared diff props

`AgentMultiFileDiff`, `AgentPatchDiff`, and `AgentFileDiff` share these props:

| Prop | Type | Purpose |
| --- | --- | --- |
| `options` | `FileDiffOptions` | Configure layout, themes, headers, interactions, and hydration. |
| `lineAnnotations` | `DiffLineAnnotation[]` | Render application-owned content on diff lines. |
| `selectedLines` | `SelectedLineRange \| null` | Control the selected line range. |

`AgentFile` uses `FileOptions` and `LineAnnotation[]`. `AgentUnresolvedFile` uses `UnresolvedFileOptions`. `AgentCodeView` accepts `CodeViewItem[]`, `CodeViewOptions`, and a `CodeViewLineSelection`.

The package also exports Pierre's `getSingularPatch`, `parseDiffFromFile`, and `parsePatchFiles` helpers plus the public types used by these components.

## Styling

The default theme maps Pierre's inherited CSS properties to Nuxt UI's `--ui-*` properties. Override a ViteHub property on one view when a product needs a different treatment:

```css
.review-diff {
  --vh-ui-bg: var(--ui-bg-elevated);
  --vh-ui-success: var(--ui-primary);
}
```

Pass Pierre's `theme` option when you need different syntax token colors. The surrounding backgrounds and semantic diff colors still follow the application theme.
