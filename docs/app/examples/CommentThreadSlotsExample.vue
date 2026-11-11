<script setup lang="ts">
import type { CommentThread } from "@vite-hub/comments/client";

const ana = { id: "ana", name: "Ana Ruiz" };
const ben = { id: "ben", name: "Ben Soto" };
const now = Date.now();

const thread: CommentThread = {
  id: "thread-3",
  scope: "site",
  n: 3,
  subject: { kind: "page", id: "/pricing" },
  anchor: { kind: "element", selector: "#hero", x: 500, y: 500 },
  status: "open",
  author: ben,
  createdAt: now - 900_000,
  updatedAt: now - 900_000,
  messages: [
    { id: "m1", threadId: "thread-3", author: ben, body: "@Ana Ruiz the hero image is cut on phones.", mentions: ["ana"], attachments: [], createdAt: now - 900_000 },
  ],
};
</script>

<template>
  <div class="w-full max-w-sm overflow-hidden rounded-lg border border-default bg-default">
    <CommentThread :thread :user="ana" :people="[ana, ben]" :dismissible="false" :attachments="false">
      <template #actions>
        <UButton aria-label="Copy link" color="neutral" icon="i-lucide-link" size="xs" variant="ghost" />
      </template>
      <template #anchor>
        <p class="mx-3 mt-3 text-xs text-muted">
          On the hero image
        </p>
      </template>
      <template #after>
        <p class="text-xs text-muted">
          Ben is looking at this page now.
        </p>
      </template>
    </CommentThread>
  </div>
</template>
