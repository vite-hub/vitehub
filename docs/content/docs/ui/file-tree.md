---
title: File Tree
description: Render and control Pierre's path-first file tree from Vue.
navigation.order: 38
navigation.group: Agent work
icon: i-ph-tree-structure-light
---

`AgentFileTree` turns a list of repository paths into an interactive `@pierre/trees` view with folders, search, selection, and Git status. Use it to browse a Workspace or the files that an Agent changed.

::component-preview{name="FileTreeExample"}
::

## Usage

```vue
<AgentFileTree
  :paths="['src/index.ts', 'src/chat/Message.vue', 'README.md']"
  :options="{ initialExpansion: 'open', search: true }"
/>
```

When you pass `paths`, the component owns the Pierre model and cleans it up when Vue unmounts the tree. A new `paths` array resets the paths. A new `options` object creates a new model.

## Examples

### Controlled model

Use `useAgentFileTree()` when application code needs selection, search, rename, drag and drop, or mutation methods. `useAgentFileTreeSelection()` returns a reactive copy of the selected paths. Pass `gitStatus` to mark added and modified files.

::component-preview{name="FileTreeControlledExample" reset}
::

```vue
<script setup lang="ts">
const tree = useAgentFileTree({
  paths,
  initialExpansion: "open",
  initialSelectedPaths: ["src/index.ts"],
});

const selectedPaths = useAgentFileTreeSelection(tree);
</script>

<template>
  <AgentFileTree :model="tree" aria-label="Repository files" />
</template>
```

When `model` is set, it is the source of truth. Do not also use `paths` or `options` as controlled inputs. Both composables dispose their subscription and the model with the current Vue scope.

## API reference

### AgentFileTree

#### Props

| Prop      | Type                             | Default | Description                                        |
| --------- | -------------------------------- | ------- | -------------------------------------------------- |
| `paths`   | `readonly string[]`              | `[]`    | Paths for the owned model.                         |
| `options` | `Omit<FileTreeOptions, 'paths'>` |         | Pierre configuration for the owned model.          |
| `model`   | `FileTree`                       |         | An application-owned model. Replaces `paths` and `options`. |

Other attributes go to the tree element. The component exposes `getModel()` through a template ref.

### useAgentFileTree

```ts
function useAgentFileTree(options: AgentFileTreeOptions): FileTree;

interface AgentFileTreeOptions extends Omit<FileTreeOptions, "paths"> {
  paths: readonly string[];
}
```

Creates a Pierre `FileTree` model. Common options are `initialExpansion`, `initialSelectedPaths`, `search`, `gitStatus`, and `onSelectionChange`. The model is cleaned up when the current Vue scope is disposed.

### useAgentFileTreeSelection

```ts
function useAgentFileTreeSelection(model: FileTree): ShallowRef<readonly string[]>;
```

Returns the selected paths. The ref updates only when the selection changes.

## Accessibility

- The inner tree has `role="tree"` and the accessible name **Files**. Pass `aria-label` for a more specific name, for example **Changed files**.
- Pierre handles keyboard navigation inside the tree.

## Related

- [Diff](/docs/ui/diff) shows the change of the selected file.
- [Code view](/docs/ui/code-view) shows the selected file's contents.
- [Code review block](/docs/ui/blocks/code-review) connects a tree to a diff.
