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
  :continuation-key="page.cursor"
  :retry-key="page.retryRevision"
  @select="openInvocation($event.id)"
  @end-reached="loadNextPage()"
/>
```

## Item data

Each `AgentInvocationListItem` requires `id`, `status`, and `title`. Add repository or pull-request `context`, a `channel`, and timestamps when available. A terminal `description` becomes the row button's accessible description and the status tooltip. The optional `project`, `agent`, and `provider` fields are available to slots; the default row does not render them.

Queued, working, failed, and cancelled statuses appear as an icon and a label. Completed sessions retain a visually hidden `Done` label. The component does not rely on color alone.

The list renders every loaded session in the order supplied by `items`, without sorting, lifecycle groups, or disclosures. Sort the data in the host application before passing it to the component.

## Props

| Prop         | Type                                 | Default          | Purpose                                           |
| ------------ | ------------------------------------ | ---------------- | ------------------------------------------------- |
| `items`      | `readonly AgentInvocationListItem[]` |                  | Application-loaded session summaries.             |
| `selectedId` | `string`                             |                  | Marks the session selected by the host.           |
| `hasMore`    | `boolean`                            | `false`          | Enables the near-end pagination signal.           |
| `loading`    | `boolean`                            | `false`          | Shows the loading state and pauses pagination.    |
| `remainingStatuses` | `readonly AgentInvocationStatus[]` | `[]`         | Deprecated; ignored by the flat list.    |
| `continuationKey` | `string \| number`              |                  | Rechecks near-end pagination after cursor progress. |
| `retryKey`   | `string \| number`                   |                  | Retries the current page after its value changes. |
| `now`        | `number`                             |                  | Timestamp used for deterministic relative times.  |
| `ariaLabel`  | `string`                             | `Agent sessions` | Accessible label for the navigation region.       |

## Pagination

The component emits `endReached` when the viewport nears the end of the loaded sessions and `hasMore` is true. Append the next cursor page to `items`. Pagination pauses while `loading` is true and does not depend on session status.

Set `continuationKey` from the current cursor so a new cursor can continue pagination when a page only refreshes already-loaded sessions. If loading fails without changing the cursor, increment `retryKey` so the same page can be requested again.

Use `header`, `footer`, `empty`, and `loading` for list states. Use `projectIcon` and `harness` to render project, Agent, or provider metadata from the slot's `item` without replacing the row behavior. These slots have no default content. Paginate large histories instead of virtualizing this navigation list.
