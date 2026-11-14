---
title: Trace
description: "Show the steps an Agent takes as compact lines that can expand into detail."
navigation.order: 14
navigation.group: Parts
icon: i-lucide-route
---

`Trace` lists the steps of an Agent turn: thoughts, searches, commands, tool calls, sources, and plan steps. Each `TraceLine` has an icon, a title, an optional description, and a status. Wrap a line in `TraceCollapsible` to show its output on expand. The parts match the names, props, and `data-slot` attributes of the [shadcn/ui Trace](https://ui.shadcn.com/docs/components/trace).

::example{name="TracePartsExample" height=12}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui`:

```ts
import { Trace, TraceLine } from "@vite-hub/ui";
```

`TraceRun` is in `@vite-hub/ui` too.

## Usage

Use a `TraceLine` for one step:

```ts
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@vite-hub/ui";
```

```vue
<template>
  <Trace>
    <TraceLine>
      <TraceIcon><UIcon name="i-lucide-search" /></TraceIcon>
      <TraceTitle>Searched for minimumReleaseAge</TraceTitle>
    </TraceLine>
  </Trace>
</template>
```

Wrap it in a `TraceCollapsible` to show detail on expand:

```vue
<template>
  <Trace>
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon><UIcon name="i-lucide-terminal" /></TraceIcon>
          <TraceTitle>Ran node --version</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>v24.18.0</TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>
</template>
```

## Composition

A trace line:

```text
Trace
└── TraceLine
    ├── TraceIcon
    ├── TraceTitle
    ├── TraceDescription
```

A line that expands:

```text
Trace
└── TraceCollapsible
    ├── TraceCollapsibleTrigger
    │   └── TraceLine
    └── TraceCollapsibleContent
```

`TraceLine` is always the line. To make it do something, wrap it in a trigger, link, or button.

## Features

- One line for thoughts, tool calls, sources, plans, and tasks.
- Lines that expand, link out, or open a modal, slideover, or popover.
- `running`, `error`, and `pending` states. The title shows the state, with no animation.
- Nested lines, so a summary expands into steps and a step into its output.
- `MessageParts` renders AI SDK reasoning, tool, and source parts with these parts.
- `TraceRun` renders a ViteHub Runtime trace run with these parts.
- Keyboard and screen reader support from the element around each line.

## Trace Line

Use a `TraceLine` alone for a step with no detail. It reads as plain text.

::example{name="TraceLineExample" height=8}
::

## Status

Set `status` when a step is running, failed, or not started.

::example{name="TraceStatusExample" height=8}
::

| Status      | Use for                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| none        | Work that is done: "Ran pnpm install".                                        |
| `"error"`   | Work that failed. Say so in the title: "Failed to run pnpm lint".             |
| `"running"` | Work in progress. Write the title in the present tense: "Running pnpm build". |
| `"pending"` | Work that has not started, such as a plan step: "Run pnpm test".              |

shadcn/ui animates a running title with a shimmer. ViteHub uses no continuous animations, so write the state in the title and use a static icon.

## Description

Put secondary text, such as a diff stat, duration, or count, in a `TraceDescription` after the `TraceTitle`. It does not truncate.

::example{name="TraceDescriptionExample" height=8}
::

## Collapsible

Put the `TraceLine` in `TraceCollapsibleTrigger` and the detail in `TraceCollapsibleContent`, inside a `TraceCollapsible`.

::example{name="TraceCollapsibleExample" height=7}
::

## Open State

Lines start closed. Set `default-open` to start open, or use `v-model:open` to control a line.

::example{name="TraceOpenStateExample" height=15}
::

To open a line while it streams but let the reader's click win, keep the reader's choice in a ref that starts `undefined`, and pass `open ?? running`:

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

::example{name="TraceLinkExample" height=8}
::

```vue
<template>
  <a href="https://nuxt.com/docs" target="_blank" rel="noreferrer">
    <TraceLine>
      <TraceTitle>
        Nuxt docs
        <span class="sr-only"> (opens in a new tab)</span>
      </TraceTitle>
      <TraceIcon><UIcon name="i-lucide-arrow-up-right" /></TraceIcon>
    </TraceLine>
  </a>
</template>
```

Use `NuxtLink` the same way for a route in your app.

## Dialog

Wrap the `TraceLine` in a button inside the trigger slot of a Nuxt UI `UModal`. The modal handles its open state, Escape, and focus return.

::example{name="TraceDialogExample" height=8}
::

```vue
<template>
  <UModal title="Searched the web for cache keys">
    <button type="button">
      <TraceLine>
        <TraceTitle>Searched the web for cache keys</TraceTitle>
        <TraceIcon><UIcon name="i-lucide-chevron-right" /></TraceIcon>
      </TraceLine>
    </button>
    <template #body>...</template>
  </UModal>
</template>
```

## Sheet

`USlideover`, `UPopover`, and `UDrawer` work the same way as the modal.

::example{name="TraceSheetExample" height=8}
::

## Group

Put adjacent lines in a `Trace`. It also styles any button or link that wraps a `TraceLine`.

::example{name="TraceGroupExample" height=8}
::

## Sources

A collapsible line whose detail is a `Trace` of link lines.

::example{name="TraceSourcesExample" height=8}
::

## Chain of Thought

A collapsible line with step lines inside. Set the parent's status and title from its children.

::example{name="TraceChainOfThoughtExample" height=12}
::

## Commit

A collapsible line with one line per changed file. Start the title with Added, Edited, or Deleted, and put line counts in the description. Each file opens its diff in a [Sheet](#sheet).

::example{name="TraceCommitExample" height=8}
::

## Whole Turn

Three levels: the turn, a summary, and the lines. Text between steps sits between two `Trace` lists.

::example{name="TraceTurnExample" height=18}
::

## Reasoning

Show an AI SDK `reasoning` part. The line is a plain `TraceLine` until the first text arrives, then opens while it streams. See [Open State](#open-state). Select **Send message** to stream the example.

::example{name="TraceReasoningExample" reset height=24}
::

[`MessageParts`](/docs/ui/message-parts) renders reasoning parts like this. Write your own only for a different layout.

## Tool

Show AI SDK tool parts. Map the part state to the title and status: "Ran" when output is available, "Failed to run" for `output-error`.

::example{name="TraceToolExample" height=15}
::

[`MessageParts`](/docs/ui/message-parts) renders tool parts with their input, output, and error.

## Trace Runs

`TraceRun` renders one run from `deriveTraceRuns()` in `@vite-hub/runtime` with these parts:

- One line with the run title, status, and duration.
- It expands into one line per timed step.
- A step with attributes expands into a small Code Block.

Open failed runs by default. Use the `step` slot when a known trace schema needs more than the default name, duration, and attributes.

```vue
<template>
  <Trace>
    <TraceLine>
      <TraceIcon><UIcon name="i-lucide-search" /></TraceIcon>
      <TraceTitle>Searched for minimumReleaseAge</TraceTitle>
    </TraceLine>
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon><UIcon name="i-lucide-terminal" /></TraceIcon>
          <TraceTitle>Ran node --version</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>v24.18.0</TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>
</template>
```

```text
Trace
├── TraceLine
│   ├── TraceIcon
│   ├── TraceTitle
│   └── TraceDescription
└── TraceCollapsible
    ├── TraceCollapsibleTrigger
    │   └── TraceLine
    └── TraceCollapsibleContent
```

```vue
<script setup lang="ts">
import { deriveTraceRuns } from "@vite-hub/runtime";

const runs = computed(() => deriveTraceRuns(events.value));
</script>

<template>
  <TraceRun v-for="run in runs" :key="run.id" :run="run" :default-open="run.status === 'failed'" />
</template>
```

::example{name="TraceExample" height=18}
::

::example{name="TraceFailedExample" height=18}
::

The status shows as text beside the title, such as `Failed · 2.8 s`. A failed line uses the error color. Durations under one second show in milliseconds. An unknown status from a newer runtime shows as its own text. ViteHub Runtime derives the `TraceRunView` records. Your app handles loading, filtering, authorization, and retention.

## Accessibility

`Trace` adds no roles. Each line gets its semantics from the element around it.

- A `TraceLine` alone is a `span`. It reads as text and is not a tab stop.
- In a `TraceCollapsibleTrigger`, the line is in a native button with `aria-expanded` and `aria-controls`. In a link, or a modal or slideover trigger, it takes that element's keyboard and focus behavior.
- `TraceIcon` sets `aria-hidden="true"`, so `TraceTitle` is the accessible name. Write what happened, like "Edited trace.ts", not only "trace.ts".
- When a link opens a new tab, add "(opens in a new tab)" to the title with `sr-only`.
- Do not use color alone. Put the status in the title too: "Running pnpm build" or "Failed to run pnpm build".
- In `TraceRun`, each step is a group named with the step name, and the status shows as text.

## API Reference

### Trace

A list of lines. It also styles buttons and links that wrap a `TraceLine`. No props. Renders a `div` with `data-slot="trace"`.

### TraceLine

One line: an icon and a title. It is a `span`, not a button or tab stop. Wrap it in a trigger or link to make it do something.

#### Props

| Prop     | Type                                | Default | Description                                  |
| -------- | ----------------------------------- | ------- | -------------------------------------------- |
| `status` | `"running" \| "error" \| "pending"` |         | The state of the work on this line. |

### TraceIcon

A decorative icon with `aria-hidden="true"`. Before the title, it names the action. After it, it is the indicator. No props.

### TraceTitle

One sentence on one line. It truncates. No props.

### TraceDescription

Secondary text after the title, such as a count or duration. It does not truncate. No props.

### TraceCollapsible

A line that expands. It is a `Collapsible` from `@ui-sdk/vue/collapsible`.

#### Props

| Prop          | Type      | Default | Description                                                       |
| ------------- | --------- | ------- | ----------------------------------------------------------------- |
| `defaultOpen` | `boolean` | `false` | Opens the line on the first render.                               |
| `open`        | `boolean` |         | The open state. Use `v-model:open`, or leave it unset for an uncontrolled line. |

#### Events

| Event         | Payload   | Description                                       |
| ------------- | --------- | ------------------------------------------------- |
| `update:open` | `boolean` | The reader opened or closed the line. |

### TraceCollapsibleTrigger

The native button that opens and closes the line. Put a `TraceLine` in it. It adds a chevron after the line. No props.

### TraceCollapsibleContent

The detail of a line. It mutes its text. A `class` goes to its inner element, so padding does not break the height animation. No props.

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

#### Types

`@vite-hub/ui` re-exports `TraceRunView`, `TraceStepView`, and `TraceEventLogEntry` from ViteHub Runtime, so you need no second import.

```ts
import type { TraceRunView, TraceStepView } from "@vite-hub/ui";

function failedSteps(run: TraceRunView): TraceStepView[] {
  return run.steps.filter(step => step.status === "failed");
}
```

Their shapes:

```ts
import type { TraceEventLogEntry } from "@vite-hub/ui";

interface TraceRunView {
  id: string;
  status: "cancelled" | "completed" | "failed" | "running";
  startTime: string;
  endTime?: string;
  durationMs?: number;
  events: TraceEventLogEntry[];
  steps: TraceStepView[];
}

interface TraceStepView {
  id: string;
  name: string;
  type: "approval" | "capability" | "error" | "lifecycle" | "policy" | "run";
  status: "completed" | "failed" | "running";
  startTime: string;
  endTime?: string;
  durationMs?: number;
  attributes?: Record<string, unknown>;
  events: TraceEventLogEntry[];
}
```

## Related

- [Console](/docs/console) shows the activities of a whole Agent Invocation.
- [Message parts](/docs/ui/message-parts) renders reasoning, tool, and source parts as Trace lines.
- [Code block](/docs/ui/code-block) shows tool output under a line.
- [Marker](/docs/ui/marker) shows status between turns.
- [Code review block](/docs/ui/blocks/code-review) shows a trace next to a diff.
