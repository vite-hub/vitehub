<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { computed, provide, ref } from "vue";
import { FileInput, FileInputDropzone } from "@ui-sdk/vue/file-input";
import { cn } from "@/lib/utils";
import type { PromptInputMessage } from "./utils";
import { promptInputKey } from "./utils";

const props = defineProps<{
  pending?: boolean;
  disabled?: boolean;
  accept?: string | string[];
  maxFiles?: number;
  maxSize?: number;
  class?: HTMLAttributes["class"];
}>();
const text = defineModel<string>({ default: "" });
const files = defineModel<File[]>("files", { default: () => [] });
const emit = defineEmits<{ submit: [message: PromptInputMessage]; stop: [] }>();

const form = ref<HTMLFormElement>();
const pending = computed(() => props.pending);
const canSubmit = computed(() => !props.disabled && (text.value.trim() !== "" || files.value.length > 0));
const textarea = () => form.value?.querySelector("textarea") ?? null;

function onSubmit() {
  if (props.pending) {
    emit("stop");
    return;
  }
  if (!canSubmit.value) return;
  emit("submit", { text: text.value, files: [...files.value] });
  text.value = "";
  files.value = [];
}

provide(promptInputKey, { text, files, pending, canSubmit, submit: () => form.value?.requestSubmit(), textarea });
</script>

<template>
  <form ref="form" data-slot="prompt-input" :class="cn('w-full', props.class)" @submit.prevent="onSubmit">
    <FileInput v-model:value="files" multiple :accept="props.accept" :max-files="props.maxFiles" :max-size="props.maxSize" :disabled="props.disabled">
      <FileInputDropzone
        :paste-target="textarea"
        class="flex flex-col rounded-xl border border-input bg-background transition-[border-color,box-shadow] duration-150 has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-1 has-[textarea:focus-visible]:ring-ring has-[textarea:focus-visible]:ring-inset data-drag-accept:border-ring data-drag-accept:bg-accent/40 data-drag-reject:border-destructive motion-reduce:transition-none"
      >
        <slot />
      </FileInputDropzone>
    </FileInput>
  </form>
</template>
