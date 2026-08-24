---
title: Invocation List
description: Browse application-loaded Agent Invocation summaries in one virtualized session list.
navigation.order: 30
navigation.group: Agent work
icon: i-ph-list-bullets-light
---

`AgentInvocationList` renders session summaries without owning search, routes, or data fetching. It keeps every status in one list and virtualizes rows when a project has many Agent Invocations.

::component-preview{name="InvocationListExample"}
::

## Usage

```vue
<AgentInvocationList
  :items="invocations"
  :selected-id="route.params.invocation"
  :has-more="page.hasMore"
  :loading="page.pending"
  @select="openInvocation($event.id)"
  @end-reached="loadNextPage()"
/>
```

## Item data

Each `AgentInvocationListItem` requires `id`, `status`, and `title`. Add project, repository or pull-request context, provider, Agent name, timestamps, and a terminal error description when available.

Status always appears as an icon and a label. The component does not rely on color alone.

## Props

| Prop         | Type                                 | Default          | Purpose                                           |
| ------------ | ------------------------------------ | ---------------- | ------------------------------------------------- |
| `items`      | `readonly AgentInvocationListItem[]` |                  | Application-loaded session summaries.             |
| `selectedId` | `string`                             |                  | Marks the session selected by the host.           |
| `virtual`    | `boolean`                            | `true`           | Virtualizes rows inside the scroll container.     |
| `hasMore`    | `boolean`                            | `false`          | Enables the near-end pagination signal.           |
| `loading`    | `boolean`                            | `false`          | Shows the loading state and pauses pagination.    |
| `retryKey`   | `string \| number`                   |                  | Retries the current page after its value changes. |
| `now`        | `number`                             |                  | Timestamp used for deterministic relative times.  |
| `ariaLabel`  | `string`                             | `Agent sessions` | Accessible label for the navigation region.       |

## Pagination

The component emits `endReached` once per loaded item count when the final visible rows enter its overscan window. Append the next cursor page to `items`. If loading fails, change `retryKey` from the retry action so the same item count can request another page.

Use `header`, `footer`, `empty`, and `loading` for list states. Use `projectIcon` and `harness` to replace repository and provider presentation without replacing the row behavior.
