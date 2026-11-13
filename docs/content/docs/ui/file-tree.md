---
title: File Tree
description: "Render Pierre's path-first file tree from Vue, control its expanded and selected state, and keep it accessible."
navigation.order: 39
navigation.group: Agent work
icon: i-lucide-network
---

`FileTree` turns a list of repository paths into an interactive `@pierre/trees` view with folders, search, selection, and Git status. Use it to browse a Workspace or the files an Agent changed.

::example{name="FileTreeExample" height=20}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui`:

```ts
import { FileTree } from "@vite-hub/ui";
```

Import `useFileTree` and `useFileTreeSelection` from `@vite-hub/ui`, also in Nuxt.

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

With `paths`, the component creates the Pierre model and cleans it up on unmount. A new `paths` array resets the paths. A new `options` object creates a new model.

## Features

- Builds folders from a flat list of paths.
- Pierre handles search, selection, keyboard navigation, and Git status.
- With `useFileTree()`, your code holds the model.

## Selected File

Use `v-model:selected-path` to keep the open file in your app state, such as a route query. When the value changes, the tree selects only that file, opens its folders, and scrolls to it. When the reader selects a file, the tree updates the value. A folder never becomes the value.

```vue
<script setup lang="ts">
const path = ref("src/chat/Message.vue");
</script>

<template>
  <FileTree v-model:selected-path="path" :paths="paths" />
</template>
```

A path that the tree does not have clears the selection. The tree selects it when `paths` gets it. [Code view](/docs/ui/code-view#open-a-file-at-its-lines) shows how to link to a file and its lines.

## Controlled Model

Use `useFileTree()` when your code needs to select, search, rename, drag and drop, or change the tree. `useFileTreeSelection()` returns a reactive copy of the selected paths. Pass `gitStatus` to mark added and modified files.

::example{name="FileTreeControlledExample" reset height=18}
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

When `model` is set, it is the source of truth. Do not also control `paths` or `options`. Both composables dispose their subscription and the model with the current Vue scope.

## Accessibility

- The tree has `role="tree"` and the name **Files**. Pass `aria-label` for a better name, such as **Changed files**.
- With `search: true`, the search input is named **Search files**. Pass `search-label` to translate it or add context, such as `search-label="Search workspace files"`. The label follows prop changes and survives search updates and model swaps.
- Pierre handles keyboard navigation inside the tree.

## API Reference

### FileTree

Renders a Pierre file tree from paths or a model.

#### Props

| Prop      | Type                             | Default | Description                                        |
| --------- | -------------------------------- | ------- | -------------------------------------------------- |
| `paths`   | `readonly string[]`              | `[]`    | Paths for the internal model. |
| `options` | `Omit<FileTreeOptions, 'paths'>` |         | Pierre options for the internal model. |
| `model`   | `FileTreeModel`                  |         | Your own model. Replaces `paths` and `options`. |
| `searchLabel` | `string`                     | `"Search files"` | Search input name. |
| `selectedPath` | `string`                    |         | The selected file. Use `v-model:selected-path`. |

#### Events

| Event | Description |
| --- | --- |
| `update:selectedPath` | The reader selected a file. Gets its path. |

Other attributes go to the tree element. A template ref exposes `getModel()`.

#### Types

`FileTreeModel` is the Pierre `FileTree` model that `useFileTree()` returns. `FileTreeOptions` adds a required `paths` list to Pierre's options.

### useFileTree

Creates a Pierre `FileTree` model.

```ts fragment
function useFileTree(options: FileTreeOptions): FileTreeModel;

interface FileTreeOptions extends Omit<PierreFileTreeOptions, "paths"> {
  paths: readonly string[];
}
```

Common options: `initialExpansion`, `initialSelectedPaths`, `search`, `gitStatus`, and `onSelectionChange`. The model is cleaned up with the current Vue scope.

### useFileTreeSelection

Returns the selected paths of a model.

```ts fragment
function useFileTreeSelection(model: FileTreeModel): ShallowRef<readonly string[]>;
```

The ref updates only when the selection changes.

## Related

- [Diff](/docs/ui/diff) shows the change of the selected file.
- [Code view](/docs/ui/code-view) shows the selected file's contents.
- [Code review block](/docs/ui/blocks/code-review) connects a tree to a diff.
