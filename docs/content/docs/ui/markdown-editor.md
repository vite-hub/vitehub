---
title: Markdown Editor
description: "Edit Markdown with comark-ui's editor and Nuxt UI's menus. Pasted, dropped, and picked files upload to Blob with a placeholder that shows the percentage."
navigation.order: 36
navigation.group: Collaboration
icon: i-lucide-notebook-pen
---

`MarkdownEditor` edits Markdown with [comark-ui's editor](https://comark-ui.onmax.me/guide/editor/). Comark syntax stays intact on save. A document it can't save unchanged opens read-only. Nuxt UI adds the bubble toolbar, "/" menu, and drag handle. The text uses the [Markdown](/docs/ui/markdown) typeset, so editing looks like reading.

::example{name="MarkdownEditorExample" reset height=8}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. Also install the Tiptap packages of Nuxt UI's editor, at 3.31.4 or a later 3.x: `@tiptap/core`, `@tiptap/pm`, `@tiptap/vue-3`, `@tiptap/starter-kit`, `@tiptap/extension-image`, `@tiptap/extension-list`, and `@tiptap/extension-table`.

Import the component from its own entry. It is not in `@vite-hub/ui`, so pages that only render Markdown don't load Tiptap:

```ts
import { MarkdownEditor } from "@vite-hub/ui/markdown-editor";
```

## Usage

Bind the Markdown with `v-model`. Pass `upload` to accept files. A string is a route that returns `blob.handleUpload()`:

```vue
<script setup lang="ts">
import { ref } from "vue";
import { MarkdownEditor } from "@vite-hub/ui/markdown-editor";

const markdown = ref("# Release notes\n");
</script>

<template>
  <MarkdownEditor v-model="markdown" upload="/api/uploads" @upload-error="(error, file) => console.error(file.name, error)" />
</template>
```

```ts [server/api/uploads.post.ts]
import { defineEventHandler } from "h3";
import { blob } from "vite-hub/blob";

// Check who may upload before this call
export default defineEventHandler(async (event) => {
  const [error, files] = await blob.handleUpload(event, {
    ensure: { maxSize: "8MB", types: ["image", "video", "audio"] },
    put: { prefix: "uploads", addRandomSuffix: true },
  });
  if (error) throw error;
  return files;
});
```

Serve the Blob store (`blob.serve`) so each file has a URL. With `upload`, the editor takes pasted and dropped images, video, and audio. The "/" menu gets an Image item that opens the file picker. Each file shows a placeholder with preview and percentage until its URL returns. The placeholder is only on your screen, so a shared room never holds a half-uploaded file.

## An editor from your app

Instead of `v-model`, pass `editor` with your own Tiptap editor, such as a Realtime room's. `MarkdownEditor` adds the upload plugin and menus and leaves the content alone. The default slot receives `{ editor }` for more menus, such as mentions or emoji.

## Accessibility

The keyboard edits text and moves through the "/" menu. The bubble toolbar shows when text is selected. Give images useful alt text in the Markdown.

## API Reference

### MarkdownEditor

#### Props

| Prop | Description |
| --- | --- |
| `modelValue` | The Markdown, bound with `v-model`. |
| `editor` | A Tiptap editor to use instead of `modelValue`. Read once, at mount. |
| `upload` | A Blob upload route, or `(file, progress) => Promise<url>` for other storage. `progress` takes 0 to 1. |
| `accept` | Files to take. Images, video, and audio by default. |
| `plugins` | The parse plugins the page renders with, so a document that needs them opens read-only. |
| `extensions` | More Tiptap extensions for the editor bound to `modelValue`. |

`upload-error` fires with the error and file when an upload fails. Its placeholder is gone by then. A string `upload` uses `blobUpload(route)`.
