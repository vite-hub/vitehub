<script setup lang="ts">
import "../core/vitehub.css";
import "./prompt-input.css";
import type { FileUIPart } from "ai";
import { computed, onBeforeUnmount, provide, ref, shallowRef, useAttrs, useTemplateRef } from "vue";
import { promptInputKey } from "./context.ts";
import { fileToUIPart, nextPromptFiles } from "./files.ts";
import PromptInputAttach from "./PromptInputAttach.vue";
import PromptInputAttachments from "./PromptInputAttachments.vue";
import PromptInputSubmit from "./PromptInputSubmit.vue";
import PromptInputTextarea from "./PromptInputTextarea.vue";
import PromptInputToolbar from "./PromptInputToolbar.vue";
import type { PromptInputEmits, PromptInputProps, PromptInputSlots } from "./types.ts";

defineOptions({ inheritAttrs: false });
const {
  modelValue,
  defaultValue = "",
  files,
  defaultFiles,
  status = "ready",
  accept,
  single = false,
  filterFiles,
  disabled = false,
  readonly = false,
  placeholder,
  submitLabel,
} = defineProps<PromptInputProps>();
const emit = defineEmits<PromptInputEmits>();
defineSlots<PromptInputSlots>();
const attrs = useAttrs();
const form = useTemplateRef<HTMLFormElement>("form");

const localText = ref(defaultValue);
const text = computed({
  get: () => modelValue ?? localText.value,
  set: (value: string) => {
    localText.value = value;
    emit("update:modelValue", value);
  },
});
const localFiles = shallowRef<readonly FileUIPart[]>(defaultFiles ?? []);
const currentFiles = computed(() => files ?? localFiles.value);
function setFiles(next: readonly FileUIPart[]) {
  localFiles.value = next;
  emit("update:files", next);
}

const pending = ref(0);
const preparing = computed(() => pending.value > 0);
const canSubmit = computed(() =>
  status === "ready" && !disabled && !readonly && !preparing.value && (text.value.trim().length > 0 || currentFiles.value.length > 0),
);

const attaches = shallowRef<ReadonlyArray<() => boolean>>([]);
const takesFiles = computed(() => !disabled && attaches.value.some((isDisabled) => !isDisabled()));
function addAttach(isDisabled: () => boolean) {
  attaches.value = [...attaches.value, isDisabled];
  return () => {
    attaches.value = attaches.value.filter((entry) => entry !== isDisabled);
  };
}

// Files read in batches. A later batch can finish first, so the files join in the order they were picked.
let disposed = false;
let nextBatch = 0;
const read = new Map<number, readonly FileUIPart[]>();
onBeforeUnmount(() => {
  disposed = true;
});
async function addFiles(input: FileList | Iterable<File>, onAccepted?: () => void) {
  if (disabled) return;
  const batch = nextBatch++;
  pending.value++;
  try {
    const picked = Array.from(input);
    const accepted = filterFiles?.(picked) ?? picked;
    if (accepted.length === 0) return;
    onAccepted?.();
    const parts = await Promise.all(Array.from(accepted, fileToUIPart));
    if (!disposed) read.set(batch, parts);
  }
  catch (error) {
    if (!disposed) emit("error", { error });
  }
  finally {
    pending.value--;
    if (!disposed && pending.value === 0 && read.size > 0) {
      const parts = [...read].sort(([first], [second]) => first - second).flatMap(([, batchParts]) => batchParts);
      read.clear();
      setFiles(nextPromptFiles(currentFiles.value, parts, single));
    }
  }
}

function onSubmit(event: Event) {
  event.preventDefault();
  if (canSubmit.value) emit("submit", { files: currentFiles.value, text: text.value.trim() });
}

provide(promptInputKey, {
  text,
  files: currentFiles,
  status: computed(() => status),
  disabled: computed(() => disabled),
  readonly: computed(() => readonly),
  placeholder: computed(() => placeholder),
  accept: computed(() => accept),
  single: computed(() => single),
  submitLabel: computed(() => submitLabel),
  label: computed(() => (typeof attrs["aria-label"] === "string" ? attrs["aria-label"] : "Message")),
  canSubmit,
  preparing,
  takesFiles,
  addAttach,
  addFiles,
  removeFile: (index) => {
    if (!disabled) setFiles(currentFiles.value.filter((_, current) => current !== index));
  },
  requestSubmit: () => form.value?.requestSubmit(),
  press: () => {
    if (status === "streaming" || status === "submitted") emit("stop");
    else if (status === "error") emit("retry");
    else form.value?.requestSubmit();
  },
});
</script>

<template>
  <form ref="form" v-bind="attrs" data-slot="prompt-input" @submit="onSubmit">
    <!-- The group is the frame of the field, so the theme marks it when the field has focus. -->
    <div data-focus-frame="" data-slot="prompt-input-group">
      <slot :can-submit="canSubmit" :preparing="preparing" :status="status">
        <PromptInputAttachments />
        <PromptInputTextarea />
        <PromptInputToolbar>
          <PromptInputAttach />
          <PromptInputSubmit />
        </PromptInputToolbar>
      </slot>
    </div>
  </form>
</template>
