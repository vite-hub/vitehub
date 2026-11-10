<script setup lang="ts">
import { createCommentsClient, type CommentThread } from "@vite-hub/comments/client";
import { createMemoryTransport } from "@vite-hub/comments/testing";

const ana = { id: "ana", name: "Ana Ruiz" };
const ben = { id: "ben", name: "Ben Soto" };
const sofia = { id: "sofia", name: "Sofía Benítez" };
const subject = { kind: "page", id: "/pricing" };
const now = Date.now();

const threads: CommentThread[] = [
  {
    id: "thread-1",
    scope: "site",
    n: 1,
    subject,
    anchor: { kind: "page" },
    status: "open",
    author: ben,
    createdAt: now - 3_600_000,
    updatedAt: now - 600_000,
    messages: [
      { id: "m1", threadId: "thread-1", author: ben, body: "@Ana Ruiz can we make the **Pro** price bigger?", mentions: ["ana"], attachments: [], createdAt: now - 3_600_000 },
      { id: "m2", threadId: "thread-1", author: ana, body: "Yes. @Sofía Benítez has the new type scale.", mentions: ["sofia"], attachments: [], createdAt: now - 600_000 },
    ],
  },
  {
    id: "thread-2",
    scope: "site",
    n: 2,
    subject,
    anchor: { kind: "page" },
    status: "resolved",
    resolvedBy: ana,
    author: sofia,
    createdAt: now - 86_400_000,
    updatedAt: now - 7_200_000,
    messages: [
      { id: "m3", threadId: "thread-2", author: sofia, body: "The FAQ link is broken.", mentions: [], attachments: [], createdAt: now - 86_400_000 },
    ],
  },
];

const client = createCommentsClient({
  transport: createMemoryTransport({ threads, user: ana, users: [ana, ben, sofia] }),
  user: ana,
});

// The example keeps files in memory. An app uploads them, for example to Blob, and returns the keys.
const files = new Map<string, string>();
async function upload(list: File[]) {
  return list.map((file) => {
    const key = `uploads/${crypto.randomUUID()}-${file.name}`;
    files.set(key, URL.createObjectURL(file));
    return key;
  });
}
</script>

<template>
  <div class="h-[30rem] w-full max-w-sm overflow-hidden rounded-lg border border-default">
    <CommentPanel
      :client
      :subject
      :upload
      :attachment-url="(key) => files.get(key)"
      accept="image/*"
    />
  </div>
</template>
