<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { FileInputItem, FileInputList } from "@ui-sdk/vue/file-input";
import { cn } from "@/lib/utils";
import PromptInputAttachment from "./PromptInputAttachment.vue";
import { usePromptInput } from "./utils";

const props = withDefaults(defineProps<{ label?: string; class?: HTMLAttributes["class"] }>(), { label: "Attachments" });
const { files } = usePromptInput();
</script>

<template>
  <FileInputList
    v-show="files.length > 0"
    :aria-label="props.label"
    :class="cn('m-0 flex list-none gap-2 overflow-x-auto p-2 pb-0', props.class)"
  >
    <FileInputItem
      v-slot="{ state }"
      data-focus-inset=""
      class="flex max-w-56 shrink-0 items-center gap-2 rounded-lg bg-muted/60 p-1 pe-1.5 outline-none data-highlighted:bg-muted"
    >
      <slot :file="state.file">
        <PromptInputAttachment :file="state.file" />
      </slot>
    </FileInputItem>
  </FileInputList>
</template>
