---
title: Invocation List
description: "Browse Agent Invocation summaries in an accessible, paginated session list."
navigation.order: 30
navigation.group: Agent work
icon: i-ph-list-bullets-light
---

`AgentInvocationList` renders Agent Invocation summaries as a navigation list. Each row shows the title, context, status, relative time, and channel. Use it as the sidebar of a session browser. It does not search, route, or fetch. Your application loads the items and handles selection.

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

The list renders the items in the order you give. It does not sort or group them.

## Examples

### Statuses

Queued, working, failed, and cancelled rows show an icon and a label. Completed rows keep a visually hidden **Done** label. Status never relies on color alone. A `description` becomes the row's accessible description and the status tooltip.

::component-preview{name="InvocationListStatusesExample"}
::

### Empty state

Use the `empty` slot when `items` is empty. Without it, the list shows **No sessions yet.**

::component-preview{name="InvocationListEmptyExample"}
::

### Pagination

The list emits `endReached` when the viewport comes near the end and `hasMore` is `true`. Append the next page to `items`. Pagination pauses while `loading` is `true`. Scroll the list to load more pages.

::component-preview{name="InvocationListPaginationExample" reset}
::

- Set `continuationKey` from the current cursor. A new cursor lets pagination continue when a page only refreshes loaded rows.
- If a request fails and the cursor does not change, increment `retryKey` to request the same page again.
- Paginate long histories. The list keeps every loaded row in the document, so keyboard and screen reader users can reach every row. It is not virtualized.

### Agent metadata

`project`, `agent`, and `provider` are not rendered by default. Use the `projectIcon` and `harness` slots to show them in each row. Use `header` and `footer` for content around the list.

::component-preview{name="InvocationListSlotsExample"}
::

## Build list items

The package exports the display helpers that the Console uses to turn a full Invocation record into a row:

```ts
import { agentInvocationContext, agentInvocationProject, agentInvocationTitle } from "@vite-hub/ui";

const items = invocations.map((invocation) => ({
  id: invocation.id,
  status: invocation.status,
  title: agentInvocationTitle(invocation),
  context: agentInvocationContext(invocation),
  project: agentInvocationProject(invocation),
  updatedAt: invocation.updatedAt,
}));
```

| Helper                       | Returns                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `agentInvocationTitle`       | `title`, then the `github.title` annotation, then `agentName`, then `"Agent Invocation"`.     |
| `agentInvocationContext`     | `owner/repo · PR #n` from GitHub annotations, then `triggeredBy`, `threadId`, `origin`, `channelId`, or `id`. |
| `agentInvocationProject`     | The repository name, then the Workspace name, then `agentName`, then `"Workspace"`.           |
| `agentInvocationExternalUrl` | The `github.url` annotation when it is an `http:` or `https:` URL.                            |

## API reference

### AgentInvocationList

#### Props

| Prop                | Type                                 | Default            | Description                                              |
| ------------------- | ------------------------------------ | ------------------ | -------------------------------------------------------- |
| `items`             | `readonly AgentInvocationListItem[]` | Required           | The loaded session summaries, in display order.          |
| `selectedId`        | `string`                             |                    | Marks the selected row with `aria-current`.              |
| `hasMore`           | `boolean`                            | `false`            | Enables the `endReached` event.                          |
| `loading`           | `boolean`                            | `false`            | Shows the loading state and pauses pagination.           |
| `continuationKey`   | `string \| number`                   |                    | Rechecks pagination when the cursor changes.             |
| `retryKey`          | `string \| number`                   |                    | Requests the current page again when the value changes.  |
| `now`               | `number`                             |                    | Timestamp for relative times. Set it for stable server rendering. Without it, rows show no time. |
| `ariaLabel`         | `string`                             | `'Agent sessions'` | Accessible name of the navigation region.                |
| `remainingStatuses` | `readonly AgentInvocationStatus[]`   | `[]`               | Deprecated. The flat list ignores it.                    |

#### Events

| Event        | Payload                   | Description                                          |
| ------------ | ------------------------- | ---------------------------------------------------- |
| `select`     | `AgentInvocationListItem` | The viewer selected a row.                           |
| `endReached` |                           | The viewport is near the end and `hasMore` is true.  |

#### Slots

| Slot          | Scope       | Description                                    |
| ------------- | ----------- | ---------------------------------------------- |
| `header`      | `{ items }` | Content above the rows.                        |
| `footer`      | `{ items }` | Content below the rows.                        |
| `empty`       |             | Replaces the empty message.                    |
| `loading`     |             | Replaces the loading message.                  |
| `projectIcon` | `{ item }`  | Project mark in a row.                         |
| `harness`     | `{ item }`  | Agent, provider, or harness label in a row.    |

#### Types

```ts
type AgentInvocationStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

interface AgentInvocationListItem {
  id: string;
  status: AgentInvocationStatus;
  title: string;
  context?: string;
  description?: string;
  channel?: string;
  agent?: string;
  project?: string;
  provider?: string;
  startedAt?: string;
  updatedAt?: string;
}
```

Running rows show the time since `startedAt`. Other rows show the time since `updatedAt`.

## Accessibility

- The list is a `<nav>` with an accessible name. Each row is a native button.
- The selected row has `aria-current="true"`.
- When a focused row moves because its status changed, focus follows the row.
- The loading message is a live status.

## Related

- [Invocation](/docs/ui/invocation) renders the selected session.
- [Invocation inspector](/docs/ui/invocation-inspector) shows its configuration.
- [Invocation dashboard block](/docs/ui/blocks/invocation-dashboard) combines all three.
