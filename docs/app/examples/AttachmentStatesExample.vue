<template>
  <div class="flex w-full max-w-sm flex-col gap-2">
    <Attachment status="idle" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-lucide-clock" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>selected-file.pdf</AttachmentTitle>
        <AttachmentDescription>Ready to upload</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction label="Remove selected-file.pdf" />
      </AttachmentActions>
    </Attachment>
    <Attachment status="uploading" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-lucide-circle-dashed" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>design-system.zip</AttachmentTitle>
        <AttachmentDescription>Uploading · 64%</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction label="Cancel the upload of design-system.zip" />
      </AttachmentActions>
    </Attachment>
    <Attachment status="processing" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-lucide-file-text" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>market-research.pdf</AttachmentTitle>
        <AttachmentDescription>Processing document</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction label="Remove market-research.pdf" />
      </AttachmentActions>
    </Attachment>
    <Attachment status="error" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-lucide-file-x" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>financial-model.xlsx</AttachmentTitle>
        <AttachmentDescription>Upload failed. Try again.</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction label="Retry the upload of financial-model.xlsx"><UIcon name="i-lucide-rotate-cw" /></AttachmentAction>
        <AttachmentAction label="Remove financial-model.xlsx" />
      </AttachmentActions>
    </Attachment>
    <Attachment status="done" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-lucide-check" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>uploaded-report.pdf</AttachmentTitle>
        <AttachmentDescription>Uploaded · 1.8 MB</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction label="Remove uploaded-report.pdf" />
      </AttachmentActions>
    </Attachment>
  </div>
</template>
