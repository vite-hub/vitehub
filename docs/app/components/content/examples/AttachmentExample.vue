<script setup lang="ts">
const images = [
  { name: "pull-requests.jpg", meta: "JPG · 64 KB", src: "/examples/my-pull-requests.jpg", alt: "A list of open pull requests" },
  { name: "org-avatar.png", meta: "PNG · 12 KB", src: "/github-org-avatar.png", alt: "The GitHub organization avatar" },
  { name: "vitehub-mark.png", meta: "PNG · 11 KB", src: "/vitehub-mark.png", alt: "The ViteHub mark" },
];
</script>

<template>
  <div class="flex w-full max-w-sm flex-col gap-3">
    <AttachmentGroup>
      <Attachment v-for="image in images" :key="image.name" orientation="vertical">
        <AttachmentMedia variant="image">
          <img :src="image.src" :alt="image.alt">
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{{ image.name }}</AttachmentTitle>
          <AttachmentDescription>{{ image.meta }}</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
    </AttachmentGroup>
    <Attachment state="uploading" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-circle-dashed-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>sales-dashboard.pdf</AttachmentTitle>
        <AttachmentDescription>Uploading · 64%</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction icon="i-ph-x-light" aria-label="Cancel the upload of sales-dashboard.pdf" />
      </AttachmentActions>
    </Attachment>
    <Attachment class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-file-code-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>message-renderer.vue</AttachmentTitle>
        <AttachmentDescription>Vue · 12 KB</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction icon="i-ph-x-light" aria-label="Remove message-renderer.vue" />
      </AttachmentActions>
    </Attachment>
  </div>
</template>
