---
title: Timeline
description: "List the timed steps of one Agent Invocation with their owner, offset, and duration."
navigation.order: 33
navigation.group: Agent work
icon: i-ph-list-checks-light
---

`AgentInvocationTimeline` lists the timed steps of one Agent Invocation: preparation, tool calls, deliveries, and other recorded work. Each row shows who ran the step, what it did, when it started, and how long it took. Select a row to jump to that step in the thread. The [Invocation inspector](/docs/ui/invocation-inspector) renders it as its **Trace timeline** section; use it on its own for a compact run view.

::component-preview{name="TimelineExample"}
::

## Usage

```vue
<AgentInvocationTimeline :invocation="record" @select-activity="selectedActivityId = $event" />
```

Pass the emitted ID to `AgentInvocation`'s `selectedActivityId` to open the work group and scroll to the step.

## How rows read

- A solid blue dot marks a step the Agent ran. A green ring marks a step ViteHub ran for it: workspace preparation, Channel delivery, and the ViteHub tools. A red cross and a red title mark a failed step.
- The title is the same sentence the thread shows, for example **Ran command**. The detail after it is the command, the path, or the recorded detail.
- The time reads **+2m 49s · 41.2s**: the offset from the Invocation start, then the duration when the trace recorded an end. The first step reads **start**.
- Messages are not steps, so the list leaves them out.

## API reference

### AgentInvocationTimeline

#### Props

| Prop         | Type                  | Default  | Description                                       |
| ------------ | --------------------- | -------- | ------------------------------------------------- |
| `invocation` | `AgentInvocationView` | Required | The Invocation and its observations.              |

#### Events

| Event            | Payload      | Description                                   |
| ---------------- | ------------ | --------------------------------------------- |
| `selectActivity` | `id: string` | The viewer selected a step.                   |

#### Slots

| Slot    | Scope | Description                                              |
| ------- | ----- | -------------------------------------------------------- |
| `empty` |       | Replaces **No timed steps recorded.** when there are none. |

#### Helpers

`invocationTimeline(invocation)` returns the rows as data:

```ts
interface AgentInvocationTimelineItem {
  id: string;
  title: string;
  detail?: string;
  owner: "agent" | "vitehub";
  offsetMs: number;
  durationMs: number;
  timing: string;
  activity: InvocationActivity;
}
```

`timelineOwner(activity)` and `formatTimelineDuration(ms)` are exported for custom rows.

## Accessibility

- Each row is a native button. Its `title` holds the full step name and detail, so truncated rows stay readable.
- Each row starts with hidden text that screen readers hear: **Agent:**, **ViteHub:**, or **Agent, failed:**. The marks differ by shape as well as color, and `data-owner` and `data-status` carry the same state for styling.

## Related

- [Invocation](/docs/ui/invocation) renders the thread that a selected step scrolls to.
- [Invocation inspector](/docs/ui/invocation-inspector) embeds this list.
- [Trace](/docs/ui/trace) renders a derived runtime trace run instead.
