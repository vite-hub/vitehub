---
title: Diffs and File Trees
description: Render Pierre code diffs and path-first file trees through Vue lifecycle adapters.
navigation.order: 30
navigation.group: Agent work
icon: i-ph-file-code-light
---

ViteHub UI uses the official framework-agnostic `@pierre/diffs` and `@pierre/trees` models. The Vue adapters own mount, update, and cleanup behavior; Pierre continues to own syntax highlighting, selection, virtualization, and tree interaction.

## Diff

Render a unified patch:

```vue
<AgentDiff :patch="patch" />
```

Or parse and configure the diff ahead of time:

```vue
<AgentDiff
  :file-diff="fileDiff"
  :options="{ diffStyle: 'split', theme: { dark: 'pierre-dark', light: 'pierre-light' } }"
/>
```

## File tree

```vue
<AgentFileTree
  :paths="['src/index.ts', 'src/chat/Message.vue', 'README.md']"
  :options="{ initialExpansion: 'open', search: true }"
/>
```

Use `useAgentFileTree()` when application code needs the Pierre model for selection, search, rename, drag-and-drop, or mutation methods.

```ts
const tree = useAgentFileTree({
  paths,
  initialExpansion: "open",
  initialSelectedPaths: ["src/index.ts"],
});

const selectedPaths = useAgentFileTreeSelection(tree);
```

Pass the model through `<AgentFileTree :model="tree" />`. ViteHub does not translate Pierre's path-first model into a second tree schema.
