---
title: Sync Status
description: "Show whether edits are loading, saving, saved, or not saved."
navigation.order: 28
navigation.group: Collaboration
icon: i-ph-cloud-check-light
---

`SyncStatus` shows where local edits stand. The values follow [Liveblocks' Yjs sync status](https://liveblocks.io/docs/api-reference/liveblocks-yjs) (`loading`, `synchronizing`, `synchronized`), plus `error` for a save that failed. The parts split as [Kibo UI's Status](https://www.kibo-ui.com/components/status).

::component-preview{name="SyncStatusExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/sync-status`:

```ts
import { SyncStatus, SyncStatusIndicator, SyncStatusLabel } from "@vite-hub/ui";
```

## Usage

Derive the status from the Realtime room:

```ts
import type { SyncStatusValue } from "@vite-hub/ui";
import { useRealtimeTiptap } from "vite-hub/realtime/vue";

const realtime = useRealtimeTiptap("docs", "guides/welcome.md");
const sync = computed<SyncStatusValue>(() => {
  if (!realtime.synced.value) return "loading";
  if (realtime.saving.value) return "synchronizing";
  return realtime.saveStatus.value.error ? "error" : "synchronized";
});
```

```vue
<template>
  <SyncStatus :status="sync" />
</template>
```

## Composition

```text
SyncStatus
├── SyncStatusIndicator
└── SyncStatusLabel
```

Without children, `SyncStatus` renders both parts.

## Features

- Four states with default labels: "Loading", "Saving", "Saved", and "Not saved".
- Pending states pulse. The pulse stops when the reader prefers reduced motion.
- `data-status` on every part, so a utility class or your own CSS can style each state.
- Pair it with [Connection Status](/docs/ui/connection-status). An editor that is offline can still have edits that wait to be saved.

## Custom Label

Put details such as the save time in `SyncStatusLabel`. The default slot receives `{ status }`.

::component-preview{name="SyncStatusLabelExample"}
::

## API reference

### SyncStatus

The root. Renders a `div` with `data-slot="sync-status"` and `data-status`.

#### Props

| Prop     | Type                                                           | Default  | Description               |
| -------- | -------------------------------------------------------------- | -------- | ------------------------- |
| `status` | `"loading" \| "synchronizing" \| "synchronized" \| "error"`    | Required | Where local edits stand.  |

### SyncStatusIndicator

A dot that shows the status. Has no props. Renders a `span` with `data-slot="sync-status-indicator"`.

### SyncStatusLabel

The status as text. The default slot receives `{ status }`. Has no props. Renders a `span` with `data-slot="sync-status-label"`.

## Accessibility

`SyncStatus` has `role="status"`, so a screen reader announces "Saved" or "Not saved" without moving focus. The indicator is decorative, and only the error state changes the text color, so the label carries the meaning.

## Related

- [Connection Status](/docs/ui/connection-status) shows the connection of the same editor.
- [Avatar Stack](/docs/ui/avatar-stack) shows who is editing.
