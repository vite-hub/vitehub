---
title: Trace
description: "Show the steps an Agent takes as compact lines that can expand into detail."
navigation.order: 14
navigation.group: Parts
icon: i-ph-path-light
---

`Trace` lists the steps of an Agent turn: searches, commands, tool calls, and plan steps. Each `TraceLine` has an icon, a title, an optional description, and a status. Wrap a line in `TraceCollapsible` to show its output when the reader expands it. The parts have the same names, props, and `data-slot` attributes as the [shadcn/ui Trace](https://ui.shadcn.com/docs/components/trace).

::component-preview{name="TracePartsExample"}
::

## Usage

```vue
<template>
  <Trace>
    <TraceLine>
      <TraceIcon><UIcon name="i-ph-magnifying-glass-light" /></TraceIcon>
      <TraceTitle>Searched for minimumReleaseAge</TraceTitle>
    </TraceLine>
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

The parts compose as follows. `TraceLine` is always the line. To make a line do something, wrap it in a trigger, a link, or a button.

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

### Status

| Status      | Use for                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| none        | Work that is done: "Ran pnpm install".                                        |
| `"error"`   | Work that failed. Say so in the title: "Failed to run pnpm lint".             |
| `"running"` | Work in progress. Write the title in the present tense: "Running pnpm build". |
| `"pending"` | Work that has not started, such as a plan step: "Run pnpm test".              |

shadcn/ui animates a running title with a shimmer. ViteHub does not use continuous animations, so write the state in the title.

### Trace runs

`AgentTrace` renders one runtime trace run from `deriveTraceRuns()` in `@vite-hub/runtime`: the run title, a status badge, and the duration, with the timed steps inside. Open failed runs by default. Use the `step` slot when a known trace schema needs more than the default name, duration, and attributes.

```vue
<script setup lang="ts">
import { deriveTraceRuns } from "@vite-hub/runtime";

const runs = computed(() => deriveTraceRuns(events.value));
</script>

<template>
  <AgentTrace v-for="run in runs" :key="run.id" :run="run" :default-open="run.status === 'failed'" />
</template>
```

::component-preview{name="TraceExample"}
::

::component-preview{name="TraceFailedExample"}
::

## API reference

### TraceLine

#### Props

| Prop     | Type                                | Default     | Description                             |
| -------- | ----------------------------------- | ----------- | --------------------------------------- |
| `status` | `"running" \| "error" \| "pending"` |  | The state of the work that the line reports. |

### TraceCollapsible

#### Props

| Prop          | Type      | Default     | Description                                                     |
| ------------- | --------- | ----------- | --------------------------------------------------------------- |
| `defaultOpen` | `boolean` | `false`     | Opens the line on the first render.                             |
| `open`        | `boolean` | `false` | The effective initial state is closed. Omit it for uncontrolled usage; use `v-model:open` to control it.                 |

#### Events

| Event         | Payload   | Description                         |
| ------------- | --------- | ----------------------------------- |
| `update:open` | `boolean` | Emitted when the reader opens or closes the line. |

### Trace

### TraceIcon

### TraceTitle

### TraceDescription

### TraceCollapsibleTrigger

### TraceCollapsibleContent

These parts have no props. `TraceIcon` sets `aria-hidden="true"`. A `class` on `TraceCollapsibleContent` goes to its inner element, so padding does not break the height animation.

### AgentTrace

#### Props

| Prop          | Type           | Default  | Description                                     |
| ------------- | -------------- | -------- | ----------------------------------------------- |
| `run`         | `TraceRunView` | Required | The derived run with its status, duration, and steps. |
| `defaultOpen` | `boolean`      | `false`  | Opens the disclosure on the first render.       |

#### Slots

| Slot    | Scope      | Description                                                      |
| ------- | ---------- | ---------------------------------------------------------------- |
| `title` | `{ run }`  | Replaces the default `Trace <id>` title.                         |
| `step`  | `{ step }` | Replaces the default step content: name, duration, and attributes. |

The badge uses the error color for `failed`, the warning color for `running`, and the success color for other statuses. Durations under one second show in milliseconds. ViteHub Runtime derives `TraceRunView` records. Loading, filtering, authorization, and retention stay in your application.

## Accessibility

- `TraceCollapsibleTrigger` is a native button with `aria-expanded` and `aria-controls`.
- Put the meaning in `TraceTitle`. Icons are hidden from screen readers, and the status color is not the only signal.
- In `AgentTrace`, each step is an `<article>` named with the step name, and the status badge shows the status as text.

## Related

- [Invocation](/docs/ui/invocation) shows the activities of a whole Agent Invocation.
- [Marker](/docs/ui/marker) shows status between turns.
- [Code review block](/docs/ui/blocks/code-review) shows a trace next to a diff.
