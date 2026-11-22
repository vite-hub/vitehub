---
title: Workspace Bar
description: "The bar over a workspace, with its sidebar, its examples menu, and the start screen of a first visit."
navigation.order: 47
navigation.group: Agent work
icon: i-lucide-panel-top
---

`WorkspaceBar` is the 44px bar over a live workspace. It holds the sidebar button, the examples menu, a step label, the run state, and the actions. Three parts go with it: `WorkspaceSidebar`, a panel that opens over the workspace; `WorkspaceExamples`, the examples menu; and `WorkspaceStart`, the examples as cards on a first visit. `PlaygroundContainer` uses the bar, the menu, and the start screen.

::example{name="WorkspaceBarExample" height=20}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The parts are in the workspace entry, so a page without them never loads CodeMirror or xterm:

```ts
import { WorkspaceBar, WorkspaceExamples, WorkspaceSidebar, WorkspaceStart } from "vite-hub/ui/workspace";
```

## Usage

Put the bar, the sidebar, and the start screen in one box with `position: relative`, such as the `bar` slot of `WorkspaceShell`. The sidebar and the start screen open under the bar, over the workspace. They do not push it.

```vue
<script setup lang="ts">
import { WorkspaceBar, WorkspaceExamples, WorkspaceSidebar, type WorkspaceExample } from "vite-hub/ui/workspace";

const examples: WorkspaceExample[] = [
  { id: "vue", label: "Vue", group: "Source language", description: "A greeting in two languages." },
  { id: "plurals", label: "Plurals", group: "Recipes", description: "Counts that read right in every locale." },
];
const example = ref("vue");
const sidebar = ref(false);
</script>

<template>
  <div class="relative h-screen">
    <WorkspaceBar v-model:sidebar="sidebar" sidebar-id="docs">
      <template #examples>
        <WorkspaceExamples v-model="example" :examples />
      </template>
      <template #actions>
        <UButton label="Copy link" />
      </template>
    </WorkspaceBar>
    <WorkspaceSidebar id="docs" v-model:open="sidebar" @reset="reset" @download="download" @copy-link="copyLink">
      <a class="vh-ws-sidebar-link" href="/docs">Introduction</a>
    </WorkspaceSidebar>
  </div>
</template>
```

### Examples menu

`WorkspaceExamples` lists the examples under the heading of their `group` and checks the open one. Examples without a group come first. A pick emits `update:modelValue` and does not open the example, so the page can ask first when the reader has edits. A share link keeps the id of the example under its `template` key, so older links still open.

::example{name="WorkspaceExamplesExample" height=26}
::

### Sidebar

`WorkspaceSidebar` opens from the sidebar button of the bar. Give the bar the same id in `sidebar-id`. Reset, Download, and Copy link sit at the bottom. Set `actions` to show fewer of them, or use the `footer` slot. The classes `vh-ws-sidebar-heading` and `vh-ws-sidebar-link` style a heading and a link in the panel.

::example{name="WorkspaceSidebarExample" height=22}
::

### Start screen

`WorkspaceStart` shows the examples as cards over the workspace. Show it only on a first visit without a share link, so a link opens its files at once. In `PlaygroundContainer`, set `start` and the container does this for you.

::example{name="WorkspaceStartExample" height=26}
::

## Accessibility

The sidebar button has `aria-expanded` and `aria-controls`, and its name says what a press does. When the sidebar opens, focus moves to its first control. Escape closes it and focus goes back to the button. A click outside also closes it. A closed sidebar is `inert`, so Tab skips it.

The examples menu is a menu of checkbox items, and the open example is checked. The arrow keys move, a typed letter jumps to the next example with that letter, and Enter opens it. The menu button names the open example, such as "Example: Vue".

The start screen is a section named by its heading. Each card is a button. Under reduced motion, the sidebar opens without a slide.

## API Reference

### WorkspaceBar

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `sidebar` | `boolean` | | Whether the sidebar is open. Set it, or use `v-model:sidebar`, to show the sidebar button. |
| `sidebarId` | `string` | | The id of the `WorkspaceSidebar`, for the `aria-controls` of the sidebar button. |
| `step` | `string` | | A label after the examples menu, such as "Step 2 of 5". |

#### Slots

| Slot | Description |
| --- | --- |
| `lead` | After the sidebar button, such as a logo and a title. |
| `examples` | The examples menu, a `WorkspaceExamples`. |
| `default` | After the step label, such as the run state. |
| `actions` | At the end of the bar. |

### WorkspaceExamples

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `examples` | `WorkspaceExample[]` | Required | Each `{ id, label, description?, group?, files? }`. |
| `modelValue` | `string \| null` | | The id of the open example. Without it, the first example shows. Pass `null` before an example is open. Use `v-model`. |
| `label` | `string` | `"Example"` | The word before the name of the open example on the button. |

`groupExamples(examples)` returns the examples by group, in the order that the menu shows them.

### WorkspaceSidebar

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `open` | `boolean` | `false` | Whether the sidebar is open. Use `v-model:open`. |
| `id` | `string` | | The id of the panel. Give the same one to `sidebar-id` of `WorkspaceBar`. |
| `label` | `string` | `"Sidebar"` | The name of the panel for screen readers. |
| `actions` | `WorkspaceSidebarAction[]` | `["reset", "download", "copy-link"]` | The buttons at the bottom, in this order. |
| `copied` | `boolean` | `false` | Set it to `true` for a moment after the link is copied. The button then says so. |

#### Events

| Event | Payload | Description |
| --- | --- | --- |
| `reset` | | The reader pressed Reset. |
| `download` | | The reader pressed Download. |
| `copy-link` | | The reader pressed Copy link. |

#### Slots

| Slot | Description |
| --- | --- |
| `default` | The content of the panel, such as the links of a guide. |
| `footer` | Replaces the buttons at the bottom. |

### WorkspaceStart

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `examples` | `WorkspaceExample[]` | Required | The cards. A card shows the number of `files` when the example has them. |
| `title` | `string` | `"Start from an example"` | The heading. |
| `description` | `string` | `"Each one runs in this tab. Edit it, then copy a link or download the files."` | The text under the heading. |

#### Events

| Event | Payload | Description |
| --- | --- | --- |
| `pick` | `string` | The id of the example that the reader picked. |

#### Slots

| Slot | Description |
| --- | --- |
| `footer` | Replaces the note under the cards. |

## Related

- [Playground render](/docs/ui/playground-render)
- [File tree](/docs/ui/file-tree)
