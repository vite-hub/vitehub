<template>
  <div class="flex w-full max-w-lg flex-col gap-3">
    <AttachmentGroup>
      <Attachment orientation="vertical">
        <AttachmentMedia>
          <UIcon name="i-ph-file-pdf-light" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>invoice.pdf</AttachmentTitle>
          <AttachmentDescription>PDF · 240 KB</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
      <Attachment orientation="vertical" state="processing">
        <AttachmentMedia>
          <UIcon name="i-ph-file-csv-light" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>usage.csv</AttachmentTitle>
          <AttachmentDescription>Reading</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
    </AttachmentGroup>
    <Attachment state="uploading" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-image-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>screenshot.png</AttachmentTitle>
        <AttachmentDescription>Uploading · 64%</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction icon="i-ph-x-light" aria-label="Cancel the upload of screenshot.png" />
      </AttachmentActions>
    </Attachment>
    <Attachment state="error" class="w-full">
      <AttachmentMedia>
        <UIcon name="i-ph-warning-circle-light" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>recording.mov</AttachmentTitle>
        <AttachmentDescription>The file is larger than 25 MB.</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction icon="i-ph-x-light" aria-label="Remove recording.mov" />
      </AttachmentActions>
    </Attachment>
  </div>
</template>
