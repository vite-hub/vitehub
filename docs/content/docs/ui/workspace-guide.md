---
title: Workspace Guide
description: "The learn parts of a workspace: the guide pane, the steps menu, the task box, file links, and the issues list."
navigation.order: 47
navigation.group: Agent work
icon: i-lucide-book-open-text
---

A lesson shows its text next to the code. These parts make that text: `WorkspaceGuide` is the guide pane with Back and Next at the bottom, `WorkspaceSteps` is the steps menu for the bar, `WorkspaceTask` is the task box of a step, `WorkspaceFileLink` opens a file in the editor, and `WorkspaceIssues` lists the problems of the last render. Put them in the slots of `WorkspaceShell` with the `guide-top` or `guide-side` layout.

::example{name="WorkspaceGuideExample" height=24}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The parts are in the workspace entry:

```ts
import { WorkspaceFileLink, WorkspaceGuide, WorkspaceIssues, WorkspaceSteps, WorkspaceTask } from "vite-hub/ui/workspace";
```

## Usage

The guide never parses Markdown. Render the text of the step yourself, such as with `ContentRenderer`, and put it in the default slot. The guide shows the position and the title of the step over the text, and Back and Next at the bottom of its pane. Bind the same step to the guide and to the steps menu in the bar, so both move together:

```vue
<script setup lang="ts">
import { WorkspaceGuide, WorkspaceShell, WorkspaceSteps } from "vite-hub/ui/workspace";

// `pages` holds the parsed Markdown of each step, such as from Nuxt Content.
const { pages } = defineProps<{ pages: { title: string }[] }>();
const steps = computed(() => pages.map(page => ({ title: page.title })));
const step = ref(0);
</script>

<template>
  <WorkspaceShell layout="guide-side">
    <template #bar>
      <WorkspaceSteps v-model:step="step" :steps label="Translate an app" />
    </template>
    <template #guide>
      <WorkspaceGuide v-model:step="step" :steps>
        <ContentRenderer :value="pages[step]" />
      </WorkspaceGuide>
    </template>
  </WorkspaceShell>
</template>
```

### Steps menu

`WorkspaceSteps` shows the current step as a menu of every step, the position, and Previous and Next buttons. Pick a step in the menu to go to it.

::example{name="WorkspaceStepsExample" height=8}
::

### Task

`WorkspaceTask` is the box under the text that tells the reader what to do next.

::example{name="WorkspaceTaskExample" height=8}
::

### File links

`WorkspaceFileLink` shows the name of a file and opens its path in the editor. The workspace gives the opener with `provideWorkspaceFileOpener({ show })`, and every link under it calls `show(path)`. The link also emits `open`, so a page without an opener can listen to it.

::example{name="WorkspaceFileLinkExample" height=8}
::

### Issues

`WorkspaceIssues` lists the issues of the last render, each with its line when it has one. `PlaygroundRender` shows its issues with it. Without issues it hides, or shows the `empty` text.

::example{name="WorkspaceIssuesExample" height=12}
::

## Accessibility

The guide is an `article`, and its title is an `h2`. A new step starts at the top of the text. Back and Next are in a `nav` named "Step navigation", and Back names the step it goes to. The steps menu is a `nav` named "Steps": its button names the current step, and Previous and Next are off at the first and last step. A file link is a button whose title holds the full path. The task box has the `note` role. The issues list is named "Issues" and is a polite live region, so screen readers hear each new list.

## API Reference

### WorkspaceGuide

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `steps` | `WorkspaceStep[]` | `[]` | The steps of the lesson, each `{ title, description? }`. |
| `step` | `number` | | The current step, from 0. Use `v-model:step`. Without it, the guide keeps its own step. |
| `title` | `string` | | The title over the text. Without it, the guide shows the title of the current step. |

#### Events

| Event | Payload | Description |
| --- | --- | --- |
| `update:step` | `number` | Back, Next, or a slot moved to another step. |

#### Slots

| Slot | Props | Description |
| --- | --- | --- |
| `default` | `{ step, total, next, previous }` | The rendered text of the step. |
| `footer` | `{ step, total, next, previous }` | Replaces Back and Next. |
| `finish` | `{ step, total, next, previous }` | Shows in place of Next on the last step, such as a link back to the lessons. |

### WorkspaceSteps

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `steps` | `WorkspaceStep[]` | Required | The steps of the lesson. The menu shows each `description` under its title. |
| `step` | `number` | | The current step, from 0. Use `v-model:step`. |
| `label` | `string` | | The heading of the menu, such as the name of the lesson. |

#### Events

| Event | Payload | Description |
| --- | --- | --- |
| `update:step` | `number` | The reader picked a step or pressed Previous or Next. |

### WorkspaceTask

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `title` | `string` | `"Try it"` | The heading of the box. |

#### Slots

| Slot | Props | Description |
| --- | --- | --- |
| `default` | | The task. |
| `title` | | Replaces the heading. |

### WorkspaceFileLink

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | Required | The path of the file in the workspace. |

#### Events

| Event | Payload | Description |
| --- | --- | --- |
| `open` | `string` | The reader clicked the link. The payload is the path. |

#### Slots

| Slot | Props | Description |
| --- | --- | --- |
| `default` | | Replaces the file name. |

### WorkspaceIssues

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `issues` | `WorkspaceIssue[]` | Required | The issues, each `{ message, line? }`. |
| `empty` | `string` | | The text to show when there are no issues. Without it, the list hides. |

## Related

- [Playground render](/docs/ui/playground-render)
- [File tree](/docs/ui/file-tree)
