<script setup lang="ts">
import { File as FileIcon } from "@lucide/vue";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "../attachment/index.ts";
import { usePromptInput } from "./context.ts";
import type { PromptInputAttachmentsProps } from "./types.ts";

const { disabled = false } = defineProps<PromptInputAttachmentsProps>();
const context = usePromptInput();
</script>

<template>
  <AttachmentGroup v-if="context && context.files.value.length > 0" data-slot="prompt-input-attachments">
    <Attachment v-for="(file, index) in context.files.value" :key="`${file.filename}-${index}`" size="xs">
      <AttachmentMedia :kind="file.mediaType.startsWith('image/') ? 'image' : 'icon'">
        <img v-if="file.mediaType.startsWith('image/')" :src="file.url" :alt="file.filename ?? file.mediaType">
        <FileIcon v-else aria-hidden="true" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{{ file.filename ?? file.mediaType }}</AttachmentTitle>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction
          :label="`Remove ${file.filename ?? 'attachment'}`"
          :disabled="disabled || context.disabled.value"
          @click="context.removeFile(index)"
        />
      </AttachmentActions>
    </Attachment>
  </AttachmentGroup>
</template>
