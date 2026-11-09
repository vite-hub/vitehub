---
title: Attachments
description: "Validate browser files, preview them, and convert them to AI SDK file parts."
navigation.order: 40
navigation.group: Utilities
icon: i-lucide-files
---

`useAgentAttachments()` holds raw `File` values, checks type, size, and count, and converts them to AI SDK `FileUIPart` values when you send. Use it for your own attachment UI, or to validate files before conversion. `PromptInput` already converts files itself.

::example{name="AttachmentsExample" reset height=8}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). Import it from `@vite-hub/ui`:

```ts
import { useAgentAttachments } from "@vite-hub/ui";
```

## Usage

```ts
import { useAgentAttachments } from "@vite-hub/ui";
```

```ts fragment
const attachments = useAgentAttachments({
  accept: "image/*,.pdf",
  maxFiles: 5,
  maxSize: 10 * 1024 * 1024,
  onReject(file, reason) {
    toast.add({ title: `${file.name}: ${reason}` });
  },
});

async function submit(text: string) {
  await sendMessage({ text, files: await attachments.toFileParts() });
  attachments.clear();
}
```

## Features

- Keeps raw `File` values until you send.
- Creates a preview URL for images.
- Gives file input attributes in `inputProps`.

## File Input

Bind `attachments.inputProps` to a file input and pass its files to `add()`:

```vue
<script setup lang="ts">
function onChange(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  if (input.files) attachments.add(input.files);
  input.value = "";
}
</script>

<template>
  <input v-bind="attachments.inputProps.value" @change="onChange">
</template>
```

Show the files with the [Attachment](/docs/ui/attachment) parts. Use `previewUrl` in an `img` for images.

## Behavior

- `add()` checks each file in order: type, then size, then count. A rejected file calls `onReject` with `"type"`, `"size"`, or `"count"`.
- Images get an object URL in `previewUrl`. It is revoked when you remove the file, clear the list, or the owning Vue scope is disposed.
- `toFileParts()` reads each file as a data URL. Files without a type get `application/octet-stream`.

> [!WARNING]
> Data URLs work as model input, but do not store them. For hosted uploads, upload the raw files first and build `FileUIPart` values with permanent URLs.

## Accessibility

The composable renders nothing, so your markup must:

- Open the hidden file input from a visible, named button, and keep the input out of the tab order.
- Give each remove button a name with the file name.
- Announce rejected files in a live region, as the example does.

## API Reference

### useAgentAttachments

Holds the selected files and their rules. Returns the files and functions to change them.

```ts fragment
function useAgentAttachments(options?: UseAgentAttachmentsOptions): AgentAttachments;
```

#### Options

| Option     | Type                                                        | Default | Description                                                         |
| ---------- | ----------------------------------------------------------- | ------- | ------------------------------------------------------------------- |
| `accept`   | `string`                                                    |         | MIME types, `type/*`, or extensions such as `.pdf`. |
| `maxFiles` | `number`                                                    |         | Maximum file count. |
| `maxSize`  | `number`                                                    |         | Maximum size per file, in bytes. |
| `multiple` | `boolean`                                                   | `true`  | When `false`, the list holds one file. |
| `onReject` | `(file: File, reason: "count" \| "size" \| "type") => void` |         | Called for each rejected file.                                      |

#### Return value

| Property      | Type                                                                | Description                                         |
| ------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| `files`       | `Ref<PendingAttachment[]>`                                          | Accepted files with `id`, `file`, and `previewUrl`. |
| `add`         | `(files: FileList \| Iterable<File>) => void`                       | Validates and adds files.                           |
| `remove`      | `(id: string) => void`                                              | Removes one file and revokes its preview URL. |
| `clear`       | `() => void`                                                        | Removes every file.                                 |
| `accept`      | `ComputedRef<string \| undefined>`                                  | The `accept` option.                                |
| `inputProps`  | `ComputedRef<{ accept?: string; multiple: boolean; type: "file" }>` | Attributes for a file input.                        |
| `toFileParts` | `() => Promise<FileUIPart[]>`                                       | Converts every file to an AI SDK file part. |

### Helpers

`@vite-hub/ui` also exports the two functions that `toFileParts()` uses.

| Function        | Signature                             | Description                               |
| --------------- | ------------------------------------- | ----------------------------------------- |
| `fileToUIPart`  | `(file: File) => Promise<FileUIPart>` | Converts one file to an AI SDK file part. |
| `fileToDataUrl` | `(file: File) => Promise<string>`     | Reads one file as a data URL.             |

## Related

- [Prompt input](/docs/ui/prompt-input) has an attachment row and paste support.
- [Message parts](/docs/ui/message-parts) renders file parts in messages.
- [Attachment](/docs/ui/attachment) shows one file with its upload state and actions.
