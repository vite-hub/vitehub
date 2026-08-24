---
title: File Tree
description: Render and control Pierre's path-first file tree from Vue.
navigation.order: 35
navigation.group: Agent work
icon: i-ph-tree-structure-light
---

`AgentFileTree` turns a list of repository paths into an interactive `@pierre/trees` view. The direct component path owns the Pierre model and cleans it up when Vue unmounts the tree.

::component-preview{name="FileTreeExample"}
::

## Usage

```vue
<AgentFileTree
  :paths="['src/index.ts', 'src/chat/Message.vue', 'README.md']"
  :options="{ initialExpansion: 'open', search: true }"
/>
```

## Controlled model

Use `useAgentFileTree()` when application code needs selection, search, rename, drag-and-drop, or mutation methods:

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

The composables dispose subscriptions and the model with the current Vue scope.

## Props

| Prop      | Type                             | Default | Purpose                                  |
| --------- | -------------------------------- | ------- | ---------------------------------------- |
| `paths`   | `readonly string[]`              | `[]`    | Paths used to create or update the tree. |
| `options` | `Omit<FileTreeOptions, 'paths'>` |         | Pierre configuration for an owned model. |
| `model`   | `FileTree`                       |         | An application-owned Pierre tree model.  |

When `model` is present, it is the source of truth. Do not also use `paths` or `options` as controlled inputs.

The inner tree is named `Files` by default. Pass `aria-label` when the surrounding context calls for a more specific name.
