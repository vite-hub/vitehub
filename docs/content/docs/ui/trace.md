---
title: Trace
description: "Show the steps an Agent takes as compact lines that can expand into detail."
navigation.order: 14
navigation.group: Parts
icon: i-ph-path-light
---

`Trace` lists the steps of an Agent turn: thoughts, searches, commands, tool calls, sources, and plan steps. Each `TraceLine` has an icon, a title, an optional description, and a status. Wrap a line in `TraceCollapsible` to show its output when the reader expands it. The parts have the same names, props, and `data-slot` attributes as the [shadcn/ui Trace](https://ui.shadcn.com/docs/components/trace).

::component-preview{name="TracePartsExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/trace`:

```ts
import { Trace, TraceLine } from "@vite-hub/ui";
```

`TraceRun` has its own entry, `@vite-hub/ui/trace-run`.

## Usage

Use a `TraceLine` for a single step:

```ts
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@vite-hub/ui";
```

```vue
<template>
  <Trace>
    <TraceLine>
      <TraceIcon><UIcon name="i-ph-magnifying-glass-light" /></TraceIcon>
      <TraceTitle>Searched for minimumReleaseAge</TraceTitle>
    </TraceLine>
  </Trace>
</template>
```

Wrap the line in a `TraceCollapsible` to show more detail when it expands:

```vue
<template>
  <Trace>
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon><UIcon name="i-ph-terminal-light" /></TraceIcon>
          <TraceTitle>Ran node --version</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>v24.18.0</TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>
</template>
```

## Composition

Use the following composition to build a trace line:

```text
Trace
└── TraceLine
    ├── TraceIcon
    ├── TraceTitle
    ├── TraceDescription
    └── TraceIcon
```

Wrap the line in a `TraceCollapsible` to show more detail when it expands:

```text
Trace
└── TraceCollapsible
    ├── TraceCollapsibleTrigger
    │   └── TraceLine
    └── TraceCollapsibleContent
```

`TraceLine` is always the line. To make a line do something, wrap it in a trigger, a link, or a button.

## Features

- One line for thoughts, tool calls, sources, plans, and tasks.
- Lines that expand, link out, or open a modal, a slideover, or a popover.
- `running`, `error`, and `pending` states. The title carries the state, with no animation.
- Nested lines, so a summary expands into steps and a step into its output.
- `MessageParts` renders AI SDK reasoning, tool, and source parts with these parts.
- `TraceRun` renders a ViteHub Runtime trace run with these parts.
- Keyboard and screen reader support from the element that wraps each line.

## Trace Line

Use a `TraceLine` alone for a step with no detail to show. It reads as plain text.

::component-preview{name="TraceLineExample"}
::

## Status

Set `status` on `TraceLine` when a step is running, failed, or has not started.

::component-preview{name="TraceStatusExample"}
::

| Status      | Use for                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| none        | Work that is done: "Ran pnpm install".                                        |
| `"error"`   | Work that failed. Say so in the title: "Failed to run pnpm lint".             |
| `"running"` | Work in progress. Write the title in the present tense: "Running pnpm build". |
| `"pending"` | Work that has not started, such as a plan step: "Run pnpm test".              |

shadcn/ui animates a running title with a shimmer. ViteHub does not use continuous animations, so write the state in the title and use a static icon.

## Description

Put secondary text such as a diff stat, a duration, or a count in a `TraceDescription` after the `TraceTitle`. It does not truncate.

::component-preview{name="TraceDescriptionExample"}
::

## Collapsible

Wrap the line in a `TraceCollapsible` to show more detail when it expands. Put the `TraceLine` in `TraceCollapsibleTrigger` and the detail in `TraceCollapsibleContent`.

::component-preview{name="TraceCollapsibleExample"}
::

## Open State

Lines start closed. Set `default-open` on `TraceCollapsible` to start open, or use `v-model:open` to control a line.

::component-preview{name="TraceOpenStateExample"}
::

To open a line while it streams and let the reader's click win, keep the reader's choice in a ref that starts as `undefined`, and pass `open ?? running`:

```vue
<script setup lang="ts">
const props = defineProps<{ running: boolean; text: string }>();
const open = ref<boolean>();
</script>

<template>
  <TraceCollapsible :open="open ?? props.running" @update:open="open = $event">
    <TraceCollapsibleTrigger>
      <TraceLine :status="props.running ? 'running' : undefined">...</TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent>{{ props.text }}</TraceCollapsibleContent>
  </TraceCollapsible>
</template>
```

## Link

Wrap the `TraceLine` in a link. For a new tab, use an arrow icon and add "(opens in a new tab)" with `sr-only`.

::component-preview{name="TraceLinkExample"}
::

```vue
<template>
  <a href="https://nuxt.com/docs" target="_blank" rel="noreferrer">
    <TraceLine>
      <TraceTitle>
        Nuxt docs
        <span class="sr-only"> (opens in a new tab)</span>
      </TraceTitle>
      <TraceIcon><UIcon name="i-ph-arrow-up-right-light" /></TraceIcon>
    </TraceLine>
  </a>
</template>
```

Use `NuxtLink` the same way for a route in your application.

## Dialog

Wrap the `TraceLine` in a button and put the button in the trigger slot of a Nuxt UI `UModal`. The modal owns its open state, Escape, and focus return.

::component-preview{name="TraceDialogExample"}
::

```vue
<template>
  <UModal title="Searched the web for cache keys">
    <button type="button">
      <TraceLine>
        <TraceTitle>Searched the web for cache keys</TraceTitle>
        <TraceIcon><UIcon name="i-ph-caret-right-light" /></TraceIcon>
      </TraceLine>
    </button>
    <template #body>...</template>
  </UModal>
</template>
```

## Sheet

A `USlideover` works the same way as the modal. `UPopover` and `UDrawer` also work.

::component-preview{name="TraceSheetExample"}
::

## Group

Put lines that sit next to each other in a `Trace`. It also styles any button or link that wraps a `TraceLine`.

::component-preview{name="TraceGroupExample"}
::

## Sources

A collapsible line whose detail is a `Trace` of link lines.

::component-preview{name="TraceSourcesExample"}
::

## Chain of Thought

A chain of thought is a collapsible line with step lines inside. Set the status and the title of the parent from its children.

::component-preview{name="TraceChainOfThoughtExample"}
::

## Commit

A commit is a collapsible line with one line for each changed file. Say what changed in the title, Added, Edited, or Deleted, and put the line counts in the description. Each file opens its diff in a [Sheet](#sheet).

::component-preview{name="TraceCommitExample"}
::

## Whole Turn

Three levels: the turn, a summary, and the lines. Text between steps sits between two `Trace` lists.

::component-preview{name="TraceTurnExample"}
::

## Reasoning

Show a `reasoning` part from the AI SDK. The line is a `TraceLine` until the first text arrives. It opens while it streams. See [Open State](#open-state). Select **Send message** to stream the example.

::component-preview{name="TraceReasoningExample" reset}
::

[`MessageParts`](/docs/ui/message-parts) renders reasoning parts in this form. Write your own only when you need a different layout.

## Tool

Show tool parts from the AI SDK. Map the state of the part to the title and the status: "Ran" when the output is available, "Failed to run" for `output-error`.

::component-preview{name="TraceToolExample"}
::

[`MessageParts`](/docs/ui/message-parts) renders tool parts with their input, output, and error.

## Trace Runs

`TraceRun` renders one runtime trace run from `deriveTraceRuns()` in `@vite-hub/runtime` with these parts. It shows one Trace line with the run title, its status, and its duration. The line expands into one line for each timed step. A step with attributes expands into a small Code Block. Open failed runs by default. Use the `step` slot when a known trace schema needs more than the default name, duration, and attributes.

```vue
<script setup lang="ts">
import { deriveTraceRuns } from "@vite-hub/runtime";

const runs = computed(() => deriveTraceRuns(events.value));
</script>

<template>
  <TraceRun v-for="run in runs" :key="run.id" :run="run" :default-open="run.status === 'failed'" />
</template>
```

::component-preview{name="TraceExample"}
::

::component-preview{name="TraceFailedExample"}
::

The status shows as text beside the title, for example `Failed · 2.8 s`. A failed line uses the error color. Durations under one second show in milliseconds. An unknown status from a newer runtime shows as its own text. ViteHub Runtime derives `TraceRunView` records. Loading, filtering, authorization, and retention stay in your application.

## Accessibility

`Trace` adds no roles of its own. Each line gets its semantics from the element that wraps it.

- A `TraceLine` alone is a `span`. It is read as text and is not a tab stop.
- In a `TraceCollapsibleTrigger`, the line is in a native button with `aria-expanded` and `aria-controls`. In a link, or in the trigger of a modal or a slideover, the line takes the keyboard and focus behavior of that element.
- `TraceIcon` sets `aria-hidden="true"`, so `TraceTitle` is the accessible name. Write it as a sentence that says what happened, like "Edited trace.ts", not only "trace.ts".
- When a link opens a new tab, add "(opens in a new tab)" to the title with `sr-only`.
- Color is not the only signal. Put the status in the title too: "Running pnpm build" while it runs and "Failed to run pnpm build" when it fails.
- In `TraceRun`, each step is a group named with the step name, and the status shows as text.

## API Reference

### Trace

A list of lines. It also styles any button or link that wraps a `TraceLine`. Has no props. Renders a `div` with `data-slot="trace"`.

### TraceLine

One line: an icon and a title. It is a `span`, so it is not a button or a tab stop. Wrap it in a trigger or a link to make it do something.

#### Props

| Prop     | Type                                | Default | Description                                  |
| -------- | ----------------------------------- | ------- | -------------------------------------------- |
| `status` | `"running" \| "error" \| "pending"` |         | The state of the work that the line reports. |

### TraceIcon

A decorative icon slot with `aria-hidden="true"`. Before the title, it names the action. After the title, it is the indicator. Has no props.

### TraceTitle

One sentence on one line. It truncates. Has no props.

### TraceDescription

Secondary text after the title, such as a count or a duration. It does not truncate. Has no props.

### TraceCollapsible

A line that expands. It is a Reka UI `CollapsibleRoot`.

#### Props

| Prop          | Type      | Default | Description                                                       |
| ------------- | --------- | ------- | ----------------------------------------------------------------- |
| `defaultOpen` | `boolean` | `false` | Opens the line on the first render.                               |
| `open`        | `boolean` |         | The open state. Use `v-model:open` to control it. Leave it unset for an uncontrolled line. |

#### Events

| Event         | Payload   | Description                                       |
| ------------- | --------- | ------------------------------------------------- |
| `update:open` | `boolean` | Emitted when the reader opens or closes the line. |

### TraceCollapsibleTrigger

The native button that opens and closes the line. Put a `TraceLine` in it. It adds a chevron after the line. Has no props.

### TraceCollapsibleContent

The detail of a line that expands. It mutes its text. A `class` goes to its inner element, so padding does not break the height animation. Has no props.

### TraceRun

#### Props

| Prop          | Type           | Default  | Description                                           |
| ------------- | -------------- | -------- | ----------------------------------------------------- |
| `run`         | `TraceRunView` | Required | The derived run with its status, duration, and steps. |
| `defaultOpen` | `boolean`      | `false`  | Opens the disclosure on the first render.             |

#### Slots

| Slot    | Scope      | Description                                                             |
| ------- | ---------- | ----------------------------------------------------------------------- |
| `title` | `{ run }`  | Replaces the default `Trace <id>` title.                                |
| `step`  | `{ step }` | Replaces the default step line: name, status, duration, and attributes. |

## Related

- [Console](/docs/development/console) shows the activities of a whole Agent Invocation.
- [Message parts](/docs/ui/message-parts) renders reasoning, tool, and source parts as Trace lines.
- [Code block](/docs/ui/code-block) shows tool output under a line.
- [Marker](/docs/ui/marker) shows status between turns.
- [Code review block](/docs/ui/blocks/code-review) shows a trace next to a diff.
