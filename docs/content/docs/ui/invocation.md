---
title: Invocation
description: Present one persisted Agent Invocation as a readable session thread.
navigation.order: 31
navigation.group: Agent work
icon: i-ph-activity-light
---

`AgentInvocation` turns the append-only observations of one Agent Invocation into a conversation. User messages are bubbles and replies are plain text. Commands, reasoning, tool calls, and file changes collapse into one work group that expands in place. Use it to review what an Agent did, live or after the run.

::component-preview{name="InvocationExample" flush}
::

## Usage

```vue
<AgentInvocation :invocation="record" @inspect="openInspector">
  <template #actions="{ invocation }">
    <InvocationActions :invocation="invocation" />
  </template>
</AgentInvocation>
```

The component receives data that your application already loaded and authorized. Your application owns loading, polling, realtime updates, replay policy, and authorization.

## How the thread reads

- User messages are right-aligned bubbles without a visible role label. Replies are plain text. Screen readers still hear **You**, **Assistant**, **System**, and **Tool**. The prompt's known author and its time appear in a row that shows on hover.
- The work group reads **Working…** with the elapsed time while the Invocation runs, and **Worked for 1m 12s** after it settles. Each activity is one row: an icon, a sentence, a muted detail, and a chevron when the row can expand.
- Tool identifiers become sentences. `exec_command` reads **Ran command**, `apply_patch` reads **Changed files**, and other snake_case names drop their underscores. A `label` in the recorded tool catalog wins over the identifier.
- A failed tool step tints its icon. A failed Invocation adds a red **Session failed** row. The terminal error also appears above the thread.
- Drivers often record the prompt again as the first user message. The thread shows it once.
- A completed `reply` or `update` delivery with captured content is the answer the user saw. It appears as an assistant message after the work group, also when the Invocation has no visible prompt. The delivery row stays in the work group without a second copy of the text.
- When the delivered text equals the final assistant message, only the message appears. Status updates and failed deliveries keep their text in the work group.

## Examples

### Running

A running Invocation shows the activities recorded so far. Pass a new record as observations arrive.

::component-preview{name="InvocationRunningExample" flush}
::

### Failed

A terminal error appears above the thread with its message, its `fix` when present, and diagnostic details.

::component-preview{name="InvocationFailedExample" flush}
::

### Pending with header slots

An Invocation without observations shows **Waiting for the first update…**. Use the `title` and `actions` slots to change the header.

::component-preview{name="InvocationPendingExample" flush}
::

## Trace content

Rich replay needs a trace log created with `{ content: "content" }`. The default metadata-only policy records activity milestones but removes prompts, message text, tool input, and tool output.

Enable full-content traces only when the store and the current viewer may keep and inspect that session content. Agent Invocation journals limit each content string to 64 KiB, each metadata string to 512 characters, collections to 32 items, nesting to four levels, and observations to 256 for each Invocation.

## API reference

### AgentInvocation

#### Props

| Prop                   | Type                  | Default  | Description                                                           |
| ---------------------- | --------------------- | -------- | --------------------------------------------------------------------- |
| `invocation`           | `AgentInvocationView` | Required | The authorized Invocation state and observations.                     |
| `header`               | `boolean`             | `true`   | Shows the project and title header. Set `false` when the host renders its own. |
| `selectedActivityId`   | `string`              |          | Opens the work group, scrolls to the activity, and focuses it. Use the ID from the inspector's `selectActivity` event. |
| `workspaceInspectable` | `boolean`             | `true`   | When `false`, removes Workspace inspection targets and skill references from activities. |

#### Events

| Event     | Payload                                        | Description                                         |
| --------- | ---------------------------------------------- | --------------------------------------------------- |
| `inspect` | `target: 'agent' \| 'workspace', path?: string` | The viewer asked to inspect the Agent or a Workspace file. |

#### Slots

| Slot      | Scope            | Description                                                |
| --------- | ---------------- | ---------------------------------------------------------- |
| `title`   | `{ invocation }` | Replaces the header title. Renders only when `header` is `true`. |
| `actions` | `{ invocation }` | Controls at the end of the header. Renders only when `header` is `true`. |
| `footer`  | `{ invocation }` | Content after the thread.                                  |

#### Types

`AgentInvocationView` is the serialized Invocation record. These are its main fields:

```ts
interface AgentInvocationView {
  id: string;
  traceId: string;
  status: AgentInvocationStatus;
  createdAt: string;
  updatedAt: string;
  observations: readonly TraceEventLogEntry[];
  agentName?: string;
  title?: string;
  annotations?: Record<string, boolean | number | string | null>;
  configuration?: AgentInvocationConfiguration;
  error?: RuntimeDiagnosticError;
  usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; cost?: { display?: string } };
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
}
```

`invocationActivities(invocation)` returns the derived activity list that the thread renders. Use it to build your own views, for example a list of file changes.

## Accessibility

- The thread is a `role="log"` region named **Session thread**. It announces additions.
- Message copy buttons announce **Message copied** or a failure through a live status.
- A selected activity receives focus, and reduced motion replaces smooth scrolling.

## Related

- [Invocation list](/docs/ui/invocation-list) selects a session.
- [Invocation inspector](/docs/ui/invocation-inspector) shows the captured configuration.
- [Trace](/docs/ui/trace) renders a derived trace run.
- [Invocation dashboard block](/docs/ui/blocks/invocation-dashboard) combines the list, thread, and inspector.
