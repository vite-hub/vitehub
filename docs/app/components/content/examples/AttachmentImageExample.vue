<script setup lang="ts">
const images = [
  { name: "pull-requests.jpg", meta: "JPG · 64 KB", src: "/examples/my-pull-requests.jpg", alt: "A list of open pull requests" },
  { name: "org-avatar.png", meta: "PNG · 12 KB", src: "/github-org-avatar.png", alt: "The GitHub organization avatar" },
  { name: "vitehub-mark.png", meta: "PNG · 11 KB", src: "/vitehub-mark.png", alt: "The ViteHub mark" },
];
</script>

<template>
  <div class="flex w-full max-w-sm flex-col gap-4">
    <AttachmentGroup class="w-full">
      <Attachment v-for="image in images" :key="image.name" orientation="vertical">
        <AttachmentMedia variant="image">
          <img :src="image.src" :alt="image.alt">
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{{ image.name }}</AttachmentTitle>
          <AttachmentDescription>{{ image.meta }}</AttachmentDescription>
        </AttachmentContent>
        <AttachmentActions>
          <AttachmentAction icon="i-ph-x-light" :aria-label="`Remove ${image.name}`" />
        </AttachmentActions>
        <AttachmentTrigger
          as="a"
          :href="image.src"
          target="_blank"
          rel="noreferrer"
          :aria-label="`Open ${image.name}`"
        />
      </Attachment>
    </AttachmentGroup>
  </div>
</template>
