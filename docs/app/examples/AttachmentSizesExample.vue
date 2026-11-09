<template>
  <div class="flex w-full max-w-sm flex-col gap-3">
    <Attachment size="default" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-file-text-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>Default attachment</AttachmentTitle>
        <AttachmentDescription>PDF · 2.4 MB</AttachmentDescription>
      </AttachmentContent>
    </Attachment>
    <Attachment size="sm" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-file-text-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>Small attachment</AttachmentTitle>
        <AttachmentDescription>PDF · 2.4 MB</AttachmentDescription>
      </AttachmentContent>
    </Attachment>
    <Attachment size="xs" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-file-text-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>Extra small attachment</AttachmentTitle>
      </AttachmentContent>
    </Attachment>
  </div>
</template>
