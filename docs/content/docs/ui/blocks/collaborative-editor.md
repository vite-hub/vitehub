---
title: Collaborative Editor
description: "A document editor that shows who is in the room, the connection, the save state, and everyone's carets."
navigation.order: 14
navigation.group: Console
icon: i-ph-users-three-light
---

This block combines [`AvatarStack`](/docs/ui/avatar-stack), [`ConnectionStatus`](/docs/ui/connection-status), [`SyncStatus`](/docs/ui/sync-status), and the [caret styles](/docs/ui/carets) around a document. Ben types, and Cleo has a phrase selected. Save to see the save state, or drop the connection to see the header wait, then say Reconnecting. The room is synthetic. No editor runs and no network requests leave the page.

::component-preview{name="CollaborativeEditorBlock" flush reset}
::

## Connect Realtime

[Realtime](/docs/realtime) runs the room. `useRealtimeTiptap()` returns everything the header needs, and its `extensions` already draw the carets with `RealtimeCaret`.

| From `useRealtimeTiptap()` | Into |
| --- | --- |
| `people` | `AvatarStack :people` |
| `status` | `ConnectionStatus :status` |
| `synced`, `history.pending`, and the result of `history.checkpoint()` | `SyncStatus :status`, derived below |
| `extensions` | The editor. Carets are on unless you pass `carets: false` |

```vue [DocumentEditor.vue]
<script setup lang="ts">
import { EditorContent, useEditor } from "@tiptap/vue-3";
import type { SyncStatusValue } from "@vite-hub/ui";
import { useRealtimeTiptap } from "vite-hub/realtime/vue";
import { computed, ref } from "vue";

const props = defineProps<{ path: string }>();
const realtime = useRealtimeTiptap("docs", props.path);
const { people, status } = realtime;
const editor = useEditor({ extensions: realtime.extensions.value });

const failed = ref(false);
const sync = computed<SyncStatusValue>(() => {
  if (!realtime.synced.value) return "loading";
  if (realtime.history.pending.value) return "synchronizing";
  return failed.value ? "error" : "synchronized";
});

// A checkpoint saves the room to the Workspace and rejects when the save fails.
async function save() {
  try {
    await realtime.history.checkpoint();
    failed.value = false;
  } catch {
    failed.value = true;
  }
}
</script>

<template>
  <header>
    <SyncStatus :status="sync" />
    <ConnectionStatus :status="status" />
    <AvatarStack :people="people" size="sm" variant="outline" />
  </header>
  <EditorContent :editor="editor" />
  <button type="button" @click="save">Save</button>
</template>
```

Key the editor component by `path`, so opening another document joins another room.

## Change the carets

Turn off the default carets and add `RealtimeCaret` yourself to change how they render. `selectionRender` returns the decoration attributes for a remote selection, and `render` builds the caret element.

```ts
import { RealtimeCaret, useRealtimeTiptap } from "vite-hub/realtime/vue";
import { markRaw } from "vue";

const realtime = useRealtimeTiptap("docs", path, { carets: false });
const extensions = [
  ...realtime.extensions.value,
  RealtimeCaret.configure({
    awareness: markRaw(realtime.provider.value!.awareness),
    selectionRender: user => ({
      class: "ProseMirror-yjs-selection",
      style: `background-color: color-mix(in oklab, ${user.color} 18%, transparent)`,
    }),
  }),
];
```

## What to keep

- `people` comes from the room's awareness, and with `auth: true` the server sets each name and image from the session. Do not let the client choose them.
- `AvatarStack` shows each person once, so a person with two tabs open shows as one face.
- The presence colors are `#RRGGBB`. The avatar rings, the carets, and the selections all use them, so each person has one color across the page.

## Components used

- [Avatar stack](/docs/ui/avatar-stack)
- [Connection status](/docs/ui/connection-status)
- [Sync status](/docs/ui/sync-status)
- [Carets](/docs/ui/carets)
