---
title: Workspace Code
description: "The code side of a workspace: a file tree with type icons and edited dots, a path breadcrumb with a wrap button, a CodeMirror editor, and a status line."
navigation.order: 47
navigation.group: Agent work
icon: i-lucide-square-code
---

The code side of a playground or a tutorial has four parts. `WorkspaceFileTree` lists the files with an icon per file type and a dot on each edited file. `WorkspaceEditorHead` shows the path of the open file and a button that wraps long lines. `WorkspaceEditor` edits the file in CodeMirror 6. `WorkspaceStatus` shows the cursor, the language, and the indentation. Put them in the slots of `WorkspaceShell`.

::example{name="WorkspaceCodeExample" reset height=26}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. The parts have their own entry, so pages without them never load CodeMirror:

```ts
import { WorkspaceEditor, WorkspaceEditorHead, WorkspaceFileTree, WorkspaceStatus } from "vite-hub/ui/workspace";
```

## Usage

Give `WorkspaceEditorHead` and `WorkspaceEditor` the same `v-model:wrap`, so the button and Alt+Z change the same value. Give the `cursor` event of the editor to `WorkspaceStatus`.

```vue
<script setup lang="ts">
import { type WorkspaceCursor, WorkspaceEditor, WorkspaceEditorHead, WorkspaceFileTree, WorkspaceShell, WorkspaceStatus } from "vite-hub/ui/workspace";

const files = ref({ "src/app.vue": "<template>Hello</template>\n" });
const selected = ref("src/app.vue");
const wrap = ref(false);
const cursor = ref<WorkspaceCursor>({ line: 1, column: 1 });
</script>

<template>
  <WorkspaceShell>
    <template #files>
      <WorkspaceFileTree v-model:selected="selected" :paths="Object.keys(files)" :edited="['src/app.vue']" />
    </template>
    <template #editor-head>
      <WorkspaceEditorHead v-model:wrap="wrap" :path="selected" />
    </template>
    <template #editor>
      <WorkspaceEditor v-model="files[selected]" v-model:wrap="wrap" :path="selected" @cursor="cursor = $event" />
    </template>
    <template #status>
      <WorkspaceStatus :cursor="cursor" :path="selected" />
    </template>
  </WorkspaceShell>
</template>
```

### File tree

`WorkspaceFileTree` is a [File tree](/docs/ui/file-tree) with the workspace look: 22px rows, an icon per file type, and an accent line on the open file. Pass the edited paths as `edited`, a list or a set. Each edited file gets a dot at the end of its row.

::example{name="WorkspaceFileTreeExample" height=18}
::

### Editor head

`WorkspaceEditorHead` shows the folders of the path, then the icon and the name of the file. The wrap button at the end is pressed while lines wrap. The default slot goes before the button, for more actions.

::example{name="WorkspaceEditorHeadExample" height=18}
::

### Status line

`WorkspaceStatus` shows `Ln`, `Col`, the language, and the indentation. The language comes from the file extension, as `workspaceLanguage(path)` returns it. Pass `language` or `indent` when you know better. The default slot goes at the end of the line.

::example{name="WorkspaceStatusExample" height=14}
::

## Accessibility

- The file tree has `role="tree"` and the name **Project files**. Pierre handles keyboard navigation in it.
- The breadcrumb is a `nav` named **File path**, with the full path as its title.
- The wrap button is named **Wrap lines**. It has `aria-pressed` and `aria-keyshortcuts="Alt+Z"`.
- The status line reads the cursor as **Line 12, column 7**.

## API Reference

### WorkspaceFileTree

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `paths` | `readonly string[]` | | The files. Folders come from the paths. |
| `edited` | `readonly string[] \| ReadonlySet<string>` | `[]` | The edited files. Each one gets a dot. |
| `selected` | `string` | | The open file. Use `v-model:selected`. |
| `label` | `string` | `"Project files"` | The name of the tree. |

#### Events

| Event | Description |
| --- | --- |
| `update:selected` | The reader opened a file. Gets its path. |

### WorkspaceEditorHead

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | | The path of the open file. |
| `wrap` | `boolean` | `false` | Whether lines wrap. Use `v-model:wrap`. |

#### Events

| Event | Description |
| --- | --- |
| `update:wrap` | The reader pressed the wrap button. Gets the new value. |

### WorkspaceEditor

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | | The file path. It picks the language. |
| `modelValue` | `string` | `""` | The file contents. Use `v-model`. |
| `readonly` | `boolean` | `false` | Blocks edits. |
| `wrap` | `boolean` | `false` | Whether lines wrap. Use `v-model:wrap`. Alt+Z toggles it. |

#### Events

| Event | Description |
| --- | --- |
| `cursor` | The cursor moved. Gets `{ line, column }`, both from 1. |
| `update:wrap` | The reader pressed Alt+Z. Gets the new value. |

A template ref exposes `focus()` and `toggleWrap()`.

### WorkspaceStatus

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | | The path of the open file. It names the language. |
| `cursor` | `WorkspaceCursor` | `{ line: 1, column: 1 }` | The cursor, from the `cursor` event of the editor. |
| `language` | `string` | | The language name. Defaults to `workspaceLanguage(path)`. |
| `indent` | `number \| "tab"` | `2` | Spaces per level, or `"tab"`. |

## Related

- [File tree](/docs/ui/file-tree) is the tree without the workspace look.
- [Code view](/docs/ui/code-view) shows a file that the reader does not edit.
- [Playground render](/docs/ui/playground-render) renders the files in the page.
