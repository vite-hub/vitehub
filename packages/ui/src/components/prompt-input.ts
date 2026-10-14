import type { ChatStatus, FileUIPart } from "ai";
import { computed, defineComponent, h, onBeforeUnmount, type PropType, ref, resolveComponent } from "vue";
import { fileToUIPart } from "../composables/attachments.ts";
import { nextPromptFiles } from "../internal/prompt-files.ts";
import { ImagePreview } from "../internal/image-preview.ts";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "./attachment.ts";

export interface PromptInputSubmit {
  files: readonly FileUIPart[];
  text: string;
}

const submitLabels: Record<ChatStatus, string> = {
  error: "Retry prompt",
  ready: "Send prompt",
  streaming: "Stop response",
  submitted: "Stop response",
};

const submitIcons: Record<ChatStatus, string> = {
  error: "i-ph-arrow-clockwise",
  ready: "i-ph-arrow-up",
  streaming: "i-ph-stop-fill",
  submitted: "i-ph-stop-fill",
};

// The shadcn/ui Prompt Input pattern: a framed textarea with attachments above it and the attach and send buttons below.
export const PromptInput = defineComponent({
  name: "PromptInput",
  inheritAttrs: false,
  props: {
    accept: { type: String },
    files: { default: () => [], type: Array as PropType<readonly FileUIPart[]> },
    filterFiles: { type: Function as PropType<(files: readonly File[]) => readonly File[]> },
    modelValue: { default: "", type: String },
    multiple: { default: true, type: Boolean },
    placeholder: { type: String },
    status: { default: "ready", type: String as PropType<ChatStatus> },
  },
  emits: ["error", "reload", "submit", "stop", "update:files", "update:modelValue"],
  setup(props, { attrs, emit, slots }) {
    const input = ref<HTMLInputElement | null>(null);
    const form = ref<HTMLFormElement | null>(null);
    const pendingFiles = ref(0);
    const preparingFiles = computed(() => pendingFiles.value > 0);
    const canSubmit = computed(() =>
      props.status === "ready" &&
      !preparingFiles.value &&
      (props.modelValue.trim().length > 0 || props.files.length > 0),
    );
    let disposed = false;
    let nextBatch = 0;
    const convertedBatches = new Map<number, readonly FileUIPart[]>();
    onBeforeUnmount(() => {
      disposed = true;
    });
    const UButton = resolveComponent("UButton");
    const UIcon = resolveComponent("UIcon");
    const remove = (index: number) => emit("update:files", props.files.filter((_, current) => current !== index));
    const addFiles = async (input: FileList | Iterable<File>, onAccepted?: () => void) => {
      const batch = nextBatch++;
      pendingFiles.value++;
      try {
        const rawFiles = Array.from(input);
        const acceptedFiles = props.filterFiles?.(rawFiles) ?? rawFiles;
        if (acceptedFiles.length === 0) return;
        onAccepted?.();
        const files = await Promise.all(Array.from(acceptedFiles, fileToUIPart));
        if (!disposed) convertedBatches.set(batch, files);
      } catch (error) {
        if (!disposed) emit("error", error);
      } finally {
        pendingFiles.value--;
        if (!disposed && pendingFiles.value === 0 && convertedBatches.size > 0) {
          const files = [...convertedBatches]
            .sort(([first], [second]) => first - second)
            .flatMap(([, converted]) => converted);
          convertedBatches.clear();
          emit("update:files", nextPromptFiles(props.files, files, props.multiple));
        }
      }
    };
    const paste = async (event: ClipboardEvent) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const hasText = clipboard.getData("text/plain").length > 0;
      const files = Array.from(clipboard.files).filter((file) => file.type.startsWith("image/") || !hasText);
      if (files.length === 0) return;
      await addFiles(files, () => event.preventDefault());
    };
    const submit = (event: Event) => {
      event.preventDefault();
      if (!canSubmit.value) return;
      emit("submit", { files: props.files, text: props.modelValue.trim() } satisfies PromptInputSubmit);
    };
    const pressSubmit = () => {
      if (props.status === "streaming" || props.status === "submitted") emit("stop");
      else if (props.status === "error") emit("reload");
      else form.value?.requestSubmit();
    };

    const attachments = () =>
      h(AttachmentGroup, { "data-slot": "prompt-input-attachments" }, () =>
        props.files.map((file, index) => {
          const label = file.filename ?? file.mediaType;
          const image = file.mediaType.startsWith("image/");
          return h(Attachment, { key: `${file.filename}-${index}`, size: "xs" }, () => [
            h(AttachmentMedia, { variant: image ? "image" : "icon" }, () =>
              image ? h(ImagePreview, { alt: label, compact: true, src: file.url }) : h(UIcon, { name: "i-ph-file-light" }),
            ),
            h(AttachmentContent, () => h(AttachmentTitle, () => label)),
            h(AttachmentActions, () =>
              h(AttachmentAction, { "aria-label": `Remove ${file.filename ?? "attachment"}`, icon: "i-ph-x-light", onClick: () => remove(index) }),
            ),
          ]);
        }),
      );

    return () =>
      h("form", { ...attrs, "data-slot": "prompt-input", onSubmit: submit, ref: form }, [
        h("div", { "data-slot": "prompt-input-group" }, [
          props.files.length > 0 || slots.files ? (slots.files?.({ files: props.files, remove }) ?? attachments()) : null,
          h("textarea", {
            "aria-label": attrs["aria-label"] ?? "Message",
            "data-slot": "prompt-input-textarea",
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLTextAreaElement).value),
            // Enter sends and Shift+Enter adds a line. Composing text with an input method never sends.
            onKeydown: (event: KeyboardEvent) => {
              if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
              event.preventDefault();
              if (props.status === "ready") form.value?.requestSubmit();
            },
            onPaste: paste,
            placeholder: props.placeholder,
            rows: 1,
            value: props.modelValue,
          }),
          h("div", { "data-slot": "prompt-input-toolbar" }, [
            h("input", {
              accept: props.accept,
              "aria-label": "Add attachment",
              class: "vh-visually-hidden",
              multiple: props.multiple,
              onChange: async (event: Event) => {
                const target = event.currentTarget;
                if (!(target instanceof HTMLInputElement)) return;
                await addFiles(target.files ?? []);
                target.value = "";
              },
              ref: input,
              tabindex: -1,
              type: "file",
            }),
            slots.actions?.() ??
              h(UButton, {
                "aria-label": "Add attachment",
                class: "rounded-full",
                color: "neutral",
                icon: "i-ph-plus",
                onClick: () => input.value?.click(),
                size: "sm",
                square: true,
                type: "button",
                variant: "outline",
              }),
            slots["footer-leading"]?.(),
            h("span", { "data-slot": "prompt-input-spacer" }),
            slots.submit?.({ canSubmit: canSubmit.value, preparingFiles: preparingFiles.value, status: props.status }) ??
              h(UButton, {
                "aria-label": submitLabels[props.status],
                class: "rounded-full",
                color: "neutral",
                disabled: props.status === "ready" && !canSubmit.value,
                icon: submitIcons[props.status],
                // Stop and Retry stay pressable while attachments convert; only Send waits for them.
                loading: props.status === "ready" && preparingFiles.value,
                onClick: pressSubmit,
                size: "sm",
                square: true,
                type: "button",
                variant: "solid",
              }),
          ]),
        ]),
      ]);
  },
});
