---
title: Attachments
description: Validate browser files, preview them, and convert them to AI SDK FileUIParts.
navigation.order: 15
navigation.group: Chat
icon: i-ph-files-light
---

Use `useAgentAttachments()` when the application needs validation or wants to keep raw `File` values until submission.

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
  await sendMessage({
    text,
    files: await attachments.toFileParts(),
  });
  attachments.clear();
}
```

The composable exposes `files`, `add()`, `remove()`, `clear()`, `inputProps`, and `toFileParts()`. Image object URLs are revoked when items are removed or the owning Vue scope is disposed.

For hosted uploads, upload the raw files first and construct `FileUIPart` values with permanent URLs. Data URLs are convenient for supported model inputs but are not a persistence strategy.
