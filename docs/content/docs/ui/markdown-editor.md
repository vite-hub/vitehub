---
title: Markdown Editor
description: "Edit Markdown with comark-ui's editor and Nuxt UI's menus. Pasted, dropped, and picked files upload to Blob with a placeholder that shows the percentage."
navigation.order: 36
navigation.group: Collaboration
icon: i-ph-note-pencil
---

`MarkdownEditor` edits Markdown with [comark-ui's editor](https://comark-ui.onmax.me/guide/editor/): Comark syntax stays intact on save, and a document the editor can't save unchanged opens read-only. Nuxt UI's bubble toolbar, "/" menu, and drag handle sit on top. The text takes the same typeset as [Markdown](/docs/ui/markdown), so editing looks like reading.

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation), and the Tiptap packages that Nuxt UI's editor uses: `@tiptap/core`, `@tiptap/pm`, `@tiptap/vue-3`, `@tiptap/starter-kit`, `@tiptap/extension-image`, `@tiptap/extension-list`, and `@tiptap/extension-table`. Import the component from its own entry. It isn't in the root barrel, so pages that only render Markdown don't load Tiptap:

```ts
import { MarkdownEditor } from "vite-hub/ui/markdown-editor";
```

## Usage

Bind the Markdown with `v-model`, and pass `upload` to take files. A string is a route that returns `blob.handleUpload()`:

```vue
<script setup lang="ts">
import { ref } from "vue";
import { MarkdownEditor } from "vite-hub/ui/markdown-editor";

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

Serve the Blob store (`blob.serve`) so each stored file has a URL the document links to. With `upload`, the editor takes pasted and dropped images, video, and audio, and the "/" menu gets an Image item that opens the file picker. Each file shows a placeholder with its preview and percentage until its URL comes back. The placeholder exists only on your screen, so a collaborative room never holds a half-uploaded file.

## An editor from your app

Pass `editor` with a Tiptap editor your app made, such as a Realtime room's, instead of `v-model`. `MarkdownEditor` adds the upload plugin and the menus to it and leaves its content alone. The default slot receives `{ editor }` for more menus, such as mentions or emoji.

## Props

| Prop | Description |
| --- | --- |
| `modelValue` | The Markdown, bound with `v-model`. |
| `editor` | A Tiptap editor to use instead of one bound to `modelValue`. Read once, at mount. |
| `upload` | A Blob upload route, or `(file, progress) => Promise<url>` for other storage. `progress` takes a fraction from 0 to 1. |
| `accept` | Which files to take. Images, video, and audio by default. |
| `plugins` | The parse plugins the page renders with, so a document only they read opens read-only. |
| `extensions` | More Tiptap extensions for the editor bound to `modelValue`. |

`upload-error` fires with the error and the file when an upload fails; its placeholder is gone by then. `blobUpload(route)` is the function a string `upload` uses.
