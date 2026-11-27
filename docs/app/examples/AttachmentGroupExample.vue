<script setup lang="ts">
interface Item {
  name: string;
  meta: string;
  icon?: string;
  src?: string;
}

const items: Item[] = [
  { name: "briefing-notes.pdf", meta: "PDF · 1.4 MB", icon: "i-lucide-file-text" },
  { name: "pull-requests.jpg", meta: "JPG · 64 KB", src: "/examples/my-pull-requests.jpg" },
  { name: "customers.csv", meta: "CSV · 18 KB", icon: "i-lucide-table" },
  { name: "message-renderer.vue", meta: "Vue · 12 KB", icon: "i-lucide-file-code" },
];
</script>

<template>
  <div class="flex w-full max-w-sm flex-col gap-4">
    <AttachmentGroup class="w-full">
      <Attachment v-for="item in items" :key="item.name" class="w-64">
        <AttachmentMedia v-if="item.src" variant="image">
          <img :src="item.src" :alt="item.name">
        </AttachmentMedia>
        <AttachmentMedia v-else-if="item.icon">
          <UIcon :name="item.icon" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{{ item.name }}</AttachmentTitle>
          <AttachmentDescription>{{ item.meta }}</AttachmentDescription>
        </AttachmentContent>
        <AttachmentActions>
          <AttachmentAction icon="i-lucide-x" :aria-label="`Remove ${item.name}`" />
        </AttachmentActions>
      </Attachment>
    </AttachmentGroup>
  </div>
</template>
