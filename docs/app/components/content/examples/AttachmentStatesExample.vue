<template>
  <div class="flex w-full max-w-sm flex-col gap-2">
    <Attachment state="idle" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-clock-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>selected-file.pdf</AttachmentTitle>
        <AttachmentDescription>Ready to upload</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction icon="i-ph-x-light" aria-label="Remove selected-file.pdf" />
      </AttachmentActions>
    </Attachment>
    <Attachment state="uploading" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-circle-dashed-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>design-system.zip</AttachmentTitle>
        <AttachmentDescription>Uploading · 64%</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction icon="i-ph-x-light" aria-label="Cancel the upload of design-system.zip" />
      </AttachmentActions>
    </Attachment>
    <Attachment state="processing" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-file-text-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>market-research.pdf</AttachmentTitle>
        <AttachmentDescription>Processing document</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction icon="i-ph-x-light" aria-label="Remove market-research.pdf" />
      </AttachmentActions>
    </Attachment>
    <Attachment state="error" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-file-x-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>financial-model.xlsx</AttachmentTitle>
        <AttachmentDescription>Upload failed. Try again.</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction icon="i-ph-arrow-clockwise-light" aria-label="Retry the upload of financial-model.xlsx" />
        <AttachmentAction icon="i-ph-x-light" aria-label="Remove financial-model.xlsx" />
      </AttachmentActions>
    </Attachment>
    <Attachment state="done" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-check-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>uploaded-report.pdf</AttachmentTitle>
        <AttachmentDescription>Uploaded · 1.8 MB</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction icon="i-ph-x-light" aria-label="Remove uploaded-report.pdf" />
      </AttachmentActions>
    </Attachment>
  </div>
</template>
