<script setup lang="ts">
import { ref, watchEffect } from "vue";
import { FileIcon, XIcon } from "@lucide/vue";
import { FileInputItemRemove, formatFileSize } from "@ui-sdk/vue/file-input";

const props = defineProps<{ file: File }>();
const preview = ref<string>();

watchEffect((onCleanup) => {
  if (!props.file.type.startsWith("image/")) {
    preview.value = undefined;
    return;
  }
  const url = URL.createObjectURL(props.file);
  preview.value = url;
  onCleanup(() => URL.revokeObjectURL(url));
});
</script>

<template>
  <span class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
    <img v-if="preview" :src="preview" alt="" class="size-full object-cover" />
    <FileIcon v-else aria-hidden="true" class="size-4" />
  </span>
  <span class="flex min-w-0 flex-col">
    <span class="truncate text-xs font-medium text-foreground">{{ props.file.name }}</span>
    <span class="text-xs text-muted-foreground tabular-nums">{{ formatFileSize(props.file.size) }}</span>
  </span>
  <FileInputItemRemove class="ms-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
    <XIcon aria-hidden="true" class="size-3.5" />
  </FileInputItemRemove>
</template>
