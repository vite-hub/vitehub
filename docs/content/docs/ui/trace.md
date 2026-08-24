---
title: Trace
description: Render a derived runtime trace run and its timed steps.
navigation.order: 33
navigation.group: Agent work
icon: i-ph-path-light
---

Use `AgentTrace` when the application already called `deriveTraceRuns()` and wants a compact disclosure for one derived run.

::component-preview{name="TraceExample"}
::

## Usage

```vue
<AgentTrace v-for="run in runs" :key="run.id" :run="run" :default-open="run.status === 'failed'" />
```

## Props

| Prop          | Type           | Default | Purpose                                     |
| ------------- | -------------- | ------- | ------------------------------------------- |
| `run`         | `TraceRunView` |         | Derived run status, duration, and steps.    |
| `defaultOpen` | `boolean`      | `false` | Opens the run disclosure on initial render. |

Use the `title` slot to replace the run identifier. Use `step` when a known trace schema deserves a richer presentation than the default step name, duration, and attributes.

## Ownership

ViteHub Runtime derives `TraceRunView` records. The UI component only renders the run it receives. Loading, filtering, authorization, and retention stay in the application.
