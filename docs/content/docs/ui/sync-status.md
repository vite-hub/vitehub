---
title: Sync Status
description: "Show whether edits are loading, saving, saved, or not saved, with a custom label and an accessible live status."
navigation.order: 32
navigation.group: Collaboration
icon: i-lucide-cloud-check
---

`SyncStatus` shows if local edits are saved. The values follow [Liveblocks' Yjs sync status](https://liveblocks.io/docs/api-reference/liveblocks-yjs) (`loading`, `synchronizing`, `synchronized`), plus `error` for a failed save. The parts match [Kibo UI's Status](https://www.kibo-ui.com/components/status).

::example{name="SyncStatusExample" height=8}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui`:

```ts
import { SyncStatus, SyncStatusIndicator, SyncStatusLabel } from "@vite-hub/ui";
```

## Usage

Derive the status from the Realtime room:

```ts
import { computed, ref } from "vue"
import type { SyncStatusValue } from "@vite-hub/ui";
import { useRealtimeTiptap } from "vite-hub/realtime/vue";

const realtime = useRealtimeTiptap("docs", "guides/welcome.md");
const failed = ref(false);
const sync = computed<SyncStatusValue>(() => {
  if (!realtime.synced.value) return "loading";
  if (realtime.history.pending.value) return "synchronizing";
  return failed.value ? "error" : "synchronized";
});

// `history.checkpoint()` saves the room to the Workspace and rejects when the save fails.
async function save() {
  try {
    await realtime.history.checkpoint();
    failed.value = false;
  } catch {
    failed.value = true;
  }
}
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
- Pending states pulse, except with reduced motion.
- Every part has `data-status` for styling each state.
- Pair it with [Connection Status](/docs/ui/connection-status). An offline editor can still have unsaved edits.

## Custom Label

Put details such as the save time in `SyncStatusLabel`. Its default slot receives `{ status }`.

::example{name="SyncStatusLabelExample" height=8}
::

## Accessibility

`SyncStatus` has `role="status"`, so screen readers announce "Saved" or "Not saved" without moving focus. The indicator is decorative and only the error state changes text color, so the label carries the meaning.

## API Reference

### SyncStatus

The root. Renders a `div` with `data-slot="sync-status"` and `data-status`.

#### Props

| Prop     | Type                                                           | Default  | Description               |
| -------- | -------------------------------------------------------------- | -------- | ------------------------- |
| `status` | `"loading" \| "synchronizing" \| "synchronized" \| "error"`    | Required | Where local edits stand.  |

### SyncStatusIndicator

A dot that shows the status. No props. Renders a `span` with `data-slot="sync-status-indicator"`.

### SyncStatusLabel

The status as text. The default slot receives `{ status }`. No props. Renders a `span` with `data-slot="sync-status-label"`.

## Related

- [Connection Status](/docs/ui/connection-status) shows the connection of the same editor.
- [Avatar Stack](/docs/ui/avatar-stack) shows who is editing.
- [Collaborative Editor](/docs/ui/blocks/collaborative-editor) combines all collaboration parts with Realtime.
