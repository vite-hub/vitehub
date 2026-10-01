---
title: Attachments
description: "Validate browser files, preview them, and convert them to AI SDK file parts."
navigation.order: 40
navigation.group: Utilities
icon: i-ph-files-light
---

`useAgentAttachments()` keeps raw `File` values with type, size, and count rules, and converts them to AI SDK `FileUIPart` values when you send. Use it when you build your own attachment UI or need validation before conversion. `AgentChatPrompt` already converts files on its own.

::component-preview{name="AttachmentsExample" reset}
::

## Usage

```ts
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

## Behavior

- `add()` checks each file in order: type, then size, then count. A rejected file calls `onReject` with `"type"`, `"size"`, or `"count"`.
- Image files get an object URL in `previewUrl`. The composable revokes it when you remove the file, clear the list, or the owning Vue scope is disposed.
- `toFileParts()` reads each file as a data URL. Files without a type get `application/octet-stream`.

Data URLs work for model inputs, but they are not a storage format. For hosted uploads, upload the raw files first and build `FileUIPart` values with permanent URLs.

## API reference

### useAgentAttachments

```ts
function useAgentAttachments(options?: UseAgentAttachmentsOptions): AgentAttachments;
```

#### Options

| Option     | Type                                                      | Default | Description                                         |
| ---------- | --------------------------------------------------------- | ------- | --------------------------------------------------- |
| `accept`   | `string`                                                  |         | Accepted types: MIME types, `type/*`, or extensions such as `.pdf`. |
| `maxFiles` | `number`                                                  |         | Maximum number of files in the list.                |
| `maxSize`  | `number`                                                  |         | Maximum size of one file, in bytes.                 |
| `multiple` | `boolean`                                                 | `true`  | When `false`, the list holds one file.              |
| `onReject` | `(file: File, reason: "count" \| "size" \| "type") => void` |         | Called for each rejected file.                      |

#### Return value

| Property      | Type                                                          | Description                                    |
| ------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| `files`       | `Ref<PendingAttachment[]>`                                    | Accepted files with `id`, `file`, and `previewUrl`. |
| `add`         | `(files: FileList \| Iterable<File>) => void`                 | Validates and adds files.                      |
| `remove`      | `(id: string) => void`                                        | Removes one file and revokes its preview URL.  |
| `clear`       | `() => void`                                                  | Removes every file.                            |
| `accept`      | `ComputedRef<string \| undefined>`                            | The `accept` option.                           |
| `inputProps`  | `ComputedRef<{ accept?: string; multiple: boolean; type: "file" }>` | Attributes for a file input.             |
| `toFileParts` | `() => Promise<FileUIPart[]>`                                 | Converts every file to an AI SDK file part.    |

### Helpers

| Function        | Signature                                 | Description                                  |
| --------------- | ----------------------------------------- | -------------------------------------------- |
| `fileToUIPart`  | `(file: File) => Promise<FileUIPart>`     | Converts one file to an AI SDK file part.    |
| `fileToDataUrl` | `(file: File) => Promise<string>`         | Reads one file as a data URL.                |

## Accessibility

The composable renders nothing, so the application owns the markup:

- Open the hidden file input from a visible button with an accessible name, and keep the input out of the tab order.
- Give each remove button a name that includes the file name.
- Announce rejected files in a live region, as the example does.

## Related

- [Chat prompt](/docs/ui/chat-prompt) has a built-in attachment row and paste support.
- [Message parts](/docs/ui/message-parts) renders file parts in messages.
