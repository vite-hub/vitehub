<script setup lang="ts">
import type { CommentThread } from "@vite-hub/comments/client";

const ana = { id: "ana", name: "Ana Ruiz" };
const ben = { id: "ben", name: "Ben Soto" };
const now = Date.now();

const thread: CommentThread = {
  id: "thread-4",
  scope: "site",
  n: 4,
  subject: { kind: "page", id: "/pricing" },
  anchor: { kind: "text", selector: "#plans", exact: "Billed yearly", prefix: "", suffix: "" },
  status: "open",
  author: ben,
  createdAt: now - 900_000,
  updatedAt: now - 300_000,
  messages: [
    { id: "m1", threadId: "thread-4", author: ben, body: "Should this say the monthly price too? Most people compare per month.", mentions: [], attachments: [], createdAt: now - 900_000 },
    { id: "m2", threadId: "thread-4", author: ana, body: "Yes. I'll add it under the yearly price.", mentions: [], attachments: [], createdAt: now - 300_000 },
  ],
};
</script>

<template>
  <div class="flex w-full flex-wrap items-start justify-center gap-4">
    <div v-for="size in (['md', 'sm'] as const)" :key="size" class="w-80 overflow-hidden rounded-lg border border-default bg-default">
      <CommentThread :thread :user="ana" :people="[ana, ben]" :dismissible="false" :size="size" @edit="() => {}" @delete="() => {}" />
    </div>
  </div>
</template>
