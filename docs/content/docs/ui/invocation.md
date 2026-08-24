---
title: Invocation
description: Present one persisted Agent Invocation as a coding-session thread.
navigation.order: 31
navigation.group: Agent work
icon: i-ph-activity-light
---

`AgentInvocation` turns append-only observations into a coding-session thread. Assistant prose stays unlabelled, user prompts remain visually distinct, and commands, reasoning, tool activity, and file changes expand in place.

::component-preview{name="InvocationExample" flush}
::

## Usage

```vue
<AgentInvocation :invocation="record" @inspect="openInspector($event)">
  <template #actions>
    <InvocationActions :invocation="record" />
  </template>
</AgentInvocation>
```

Set `header` to `false` when the host already renders repository and session navigation above the thread.

## Props and events

| Contract     | Type                      | Purpose                                               |
| ------------ | ------------------------- | ----------------------------------------------------- |
| `invocation` | `AgentInvocationView`     | Authorized invocation state and observations.         |
| `header`     | `boolean`, default `true` | Shows the project and session breadcrumb.             |
| `inspect`    | `'agent' \| 'workspace'`  | Requests host-owned inspection for a selected target. |

The `title`, `actions`, and `footer` slots add host controls without changing the transcript renderer.

## Trace content

Rich replay requires a trace log created with `{ content: "content" }`. The default metadata-only policy records activity milestones but strips prompts, message text, tool input, and tool output.

Enable full-content traces only when the store and current viewer may retain and inspect that session content. Agent Invocation journals bound each content string to 64 KiB, each metadata string to 512 characters, collections to 32 items, nesting to four levels, and observations to 256 per invocation.

## Data ownership

The component receives already-authorized data. The application owns loading, polling, realtime updates, replay policy, and authorization.
