<script setup lang="ts">
const open = ref(false);
</script>

<template>
  <div class="flex w-full max-w-sm flex-col gap-4">
    <Attachment class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-file-magnifying-glass-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>research-summary.pdf</AttachmentTitle>
        <AttachmentDescription>Open the preview dialog</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction icon="i-ph-copy-light" aria-label="Copy the link to research-summary.pdf" />
        <AttachmentAction icon="i-ph-x-light" aria-label="Remove research-summary.pdf" />
      </AttachmentActions>
      <AttachmentTrigger aria-label="Preview research-summary.pdf" @click="open = true" />
    </Attachment>
    <UModal
      v-model:open="open"
      title="research-summary.pdf"
      description="The attachment trigger fills the card and opens this dialog. The actions stay clickable above it."
    />
  </div>
</template>
