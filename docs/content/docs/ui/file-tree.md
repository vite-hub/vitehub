---
title: File Tree
description: Render and control Pierre's path-first file tree from Vue.
navigation.order: 39
navigation.group: Agent work
icon: i-ph-tree-structure-light
---

`FileTree` turns a list of repository paths into an interactive `@pierre/trees` view with folders, search, selection, and Git status. Use it to browse a Workspace or the files that an Agent changed.

::component-preview{name="FileTreeExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/file-tree`:

```ts
import { FileTree } from "@vite-hub/ui";
```

The composables `useFileTree` and `useFileTreeSelection` come from `@vite-hub/ui` only. Import them in Nuxt too.

## Usage

```ts
import { FileTree } from "@vite-hub/ui";
```

```vue
<template>
  <FileTree
    :paths="['src/index.ts', 'src/chat/Message.vue', 'README.md']"
    :options="{ initialExpansion: 'open', search: true }"
  />
</template>
```

When you pass `paths`, the component owns the Pierre model and cleans it up when Vue unmounts the tree. A new `paths` array resets the paths. A new `options` object creates a new model.

## Features

- Builds folders from a flat list of repository paths.
- Pierre's `@pierre/trees` owns search, selection, keyboard navigation, and Git status.
- With `paths`, the component owns the model and cleans it up on unmount.
- With `useFileTree()`, application code owns the model and can select, search, rename, drag and drop, and mutate it.
- `useFileTreeSelection()` returns a reactive copy of the selected paths.

## Controlled Model

Use `useFileTree()` when application code needs selection, search, rename, drag and drop, or mutation methods. `useFileTreeSelection()` returns a reactive copy of the selected paths. Pass `gitStatus` to mark added and modified files.

::component-preview{name="FileTreeControlledExample" reset}
::

```vue
<script setup lang="ts">
import { useFileTree, useFileTreeSelection } from "@vite-hub/ui";

const tree = useFileTree({
  paths,
  initialExpansion: "open",
  initialSelectedPaths: ["src/index.ts"],
});

const selectedPaths = useFileTreeSelection(tree);
</script>

<template>
  <FileTree :model="tree" aria-label="Repository files" />
</template>
```

When `model` is set, it is the source of truth. Do not also use `paths` or `options` as controlled inputs. Both composables dispose their subscription and the model with the current Vue scope.

## Accessibility

- The inner tree has `role="tree"` and the accessible name **Files**. Pass `aria-label` for a more specific name, for example **Changed files**.
- Pierre handles keyboard navigation inside the tree.

## API Reference

### FileTree

Renders a Pierre file tree from paths or from a model.

#### Props

| Prop      | Type                             | Default | Description                                        |
| --------- | -------------------------------- | ------- | -------------------------------------------------- |
| `paths`   | `readonly string[]`              | `[]`    | Paths for the owned model.                         |
| `options` | `Omit<FileTreeOptions, 'paths'>` |         | Pierre configuration for the owned model.          |
| `model`   | `FileTreeModel`                  |         | An application-owned model. Replaces `paths` and `options`. |

Other attributes go to the tree element. The component exposes `getModel()` through a template ref.

#### Types

`FileTreeModel` is the Pierre `FileTree` model that `useFileTree()` returns and `FileTree` renders. `FileTreeOptions` adds a required `paths` list to Pierre's tree options.

### useFileTree

Creates a Pierre `FileTree` model.

```ts
function useFileTree(options: FileTreeOptions): FileTreeModel;

interface FileTreeOptions extends Omit<PierreFileTreeOptions, "paths"> {
  paths: readonly string[];
}
```

Common options are `initialExpansion`, `initialSelectedPaths`, `search`, `gitStatus`, and `onSelectionChange`. The model is cleaned up when the current Vue scope is disposed.

### useFileTreeSelection

Returns the selected paths of a model.

```ts
function useFileTreeSelection(model: FileTreeModel): ShallowRef<readonly string[]>;
```

The ref updates only when the selection changes.

## Related

- [Diff](/docs/ui/diff) shows the change of the selected file.
- [Code view](/docs/ui/code-view) shows the selected file's contents.
- [Code review block](/docs/ui/blocks/code-review) connects a tree to a diff.
