---
title: Invocation List
description: Browse application-loaded Agent Invocation summaries in an accessible session list.
navigation.order: 30
navigation.group: Agent work
icon: i-ph-list-bullets-light
---

`AgentInvocationList` renders session summaries without owning search, routes, or data fetching. It keeps every loaded session in the document so keyboard and assistive-technology users can reach the same navigation choices.

::component-preview{name="InvocationListExample"}
::

## Usage

```vue
<AgentInvocationList
  :items="invocations"
  :selected-id="route.params.invocation"
  :has-more="page.hasMore"
  :loading="page.pending"
  :remaining-statuses="page.remainingStatuses"
  :retry-key="page.cursor"
  @select="openInvocation($event.id)"
  @end-reached="loadNextPage()"
/>
```

## Item data

Each `AgentInvocationListItem` requires `id`, `status`, and `title`. Add project, repository or pull-request context, provider, Agent name, timestamps, and a terminal error description when available.

Status always appears as an icon and a label. The component does not rely on color alone.

The list groups sessions by lifecycle and sorts each group by its most recent activity. Working sessions remain visible. Queued and Done use native disclosures, with Queued open and Done closed by default. Selecting a queued or terminal session opens its group.

## Props

| Prop         | Type                                 | Default          | Purpose                                           |
| ------------ | ------------------------------------ | ---------------- | ------------------------------------------------- |
| `items`      | `readonly AgentInvocationListItem[]` |                  | Application-loaded session summaries.             |
| `selectedId` | `string`                             |                  | Marks the session selected by the host.           |
| `hasMore`    | `boolean`                            | `false`          | Enables the near-end pagination signal.           |
| `loading`    | `boolean`                            | `false`          | Shows the loading state and pauses pagination.    |
| `remainingStatuses` | `readonly AgentInvocationStatus[]` | `[]`         | Statuses that may appear on later cursor pages.    |
| `retryKey`   | `string \| number`                   |                  | Retries the current page after its value changes. |
| `now`        | `number`                             |                  | Timestamp used for deterministic relative times.  |
| `ariaLabel`  | `string`                             | `Agent sessions` | Accessible label for the navigation region.       |

## Pagination

The component emits `endReached` when the viewport nears the end of the visible sessions. Append the next cursor page to `items` and pass the statuses that remain behind that cursor through `remainingStatuses`. The component can then continue through closed Done pages when an older Working or Queued session is still reachable, without automatically loading the entire closed Done history.

Set `retryKey` from the current cursor so a new cursor can continue pagination even when a page only refreshes already-loaded sessions. If loading fails without changing the cursor, include a retry revision in the key so the same page can be requested again.

Use `header`, `footer`, `empty`, and `loading` for list states. Use `projectIcon` and `harness` to replace repository and provider presentation without replacing the row behavior. Paginate large histories instead of virtualizing this navigation list.
