---
title: Trace
description: Render a derived runtime trace run and its timed steps in a compact disclosure.
navigation.order: 36
navigation.group: Agent work
icon: i-ph-path-light
---

`AgentTrace` renders one trace run as a disclosure: the run title, a status badge, and the duration, with the timed steps inside. Use it after you call `deriveTraceRuns()` from `@vite-hub/runtime`, for example to show a verification run next to a diff.

::component-preview{name="TraceExample"}
::

## Usage

```vue
<script setup lang="ts">
import { deriveTraceRuns } from "@vite-hub/runtime";

const runs = computed(() => deriveTraceRuns(events.value));
</script>

<template>
  <AgentTrace v-for="run in runs" :key="run.id" :run="run" :default-open="run.status === 'failed'" />
</template>
```

## Examples

### Failed run with a custom step

Open failed runs by default. Use the `step` slot when a known trace schema needs more than the default name, duration, and attributes.

::component-preview{name="TraceFailedExample"}
::

## API reference

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

The badge uses the error color for `failed`, the warning color for `running`, and the success color for other statuses. Durations under one second show in milliseconds.

## Accessibility

- The trigger is a native button inside a Nuxt UI collapsible.
- Each step is an `<article>` named with the step name.
- The status badge shows the status as text, not only as color.

## Ownership

ViteHub Runtime derives `TraceRunView` records. The component only renders the run it receives. Loading, filtering, authorization, and retention stay in your application.

## Related

- [Invocation](/docs/ui/invocation) shows the activities of a whole Agent Invocation.
- [Code review block](/docs/ui/blocks/code-review) shows a trace next to a diff.
