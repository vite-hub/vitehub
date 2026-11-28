<script setup lang="ts">
import { FileText } from "@lucide/vue";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "../attachment/index.ts";
</script>

<template>
  <div data-slot="example-attachment" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 24rem">
    <Attachment>
      <AttachmentMedia>
        <FileText aria-hidden="true" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>release-notes.pdf</AttachmentTitle>
        <AttachmentDescription>PDF · 240 KB</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction label="Remove release-notes.pdf" />
      </AttachmentActions>
    </Attachment>
    <Attachment status="uploading" size="sm">
      <AttachmentMedia>
        <FileText aria-hidden="true" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>design-system.zip</AttachmentTitle>
        <AttachmentDescription>Uploading · 64%</AttachmentDescription>
      </AttachmentContent>
    </Attachment>
    <AttachmentGroup>
      <Attachment size="xs">
        <AttachmentContent>
          <AttachmentTitle>notes.txt</AttachmentTitle>
        </AttachmentContent>
      </Attachment>
      <Attachment size="xs" status="error">
        <AttachmentContent>
          <AttachmentTitle>model.xlsx</AttachmentTitle>
        </AttachmentContent>
      </Attachment>
    </AttachmentGroup>
  </div>
</template>
