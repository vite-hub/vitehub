import type { ChatStatus, FileUIPart } from "ai";
import { defineComponent, h, type PropType, ref, resolveComponent } from "vue";
import { fileToUIPart } from "../composables/attachments.ts";
import { nextPromptFiles } from "../internal/prompt-files.ts";

const attachmentSubmitSentinel = "\u200B";

export interface AgentChatPromptSubmit {
  files: readonly FileUIPart[];
  text: string;
}

export const AgentChatPrompt = defineComponent({
  name: "AgentChatPrompt",
  inheritAttrs: false,
  props: {
    accept: { type: String },
    files: { default: () => [], type: Array as PropType<readonly FileUIPart[]> },
    modelValue: { default: "", type: String },
    multiple: { default: true, type: Boolean },
    placeholder: { type: String },
    status: { default: "ready", type: String as PropType<ChatStatus> },
  },
  emits: ["reload", "submit", "stop", "update:files", "update:modelValue"],
  setup(props, { attrs, emit, slots }) {
    const input = ref<HTMLInputElement | null>(null);
    const UButton = resolveComponent("UButton");
    const UChatPrompt = resolveComponent("UChatPrompt");
    const UChatPromptSubmit = resolveComponent("UChatPromptSubmit");
    const remove = (index: number) =>
      emit(
        "update:files",
        props.files.filter((_, current) => current !== index),
      );
    return () =>
      h(
        UChatPrompt,
        {
          ...attrs,
          "aria-label": attrs["aria-label"] ?? "Message",
          class: ["vh-prompt", attrs.class],
          modelValue: props.modelValue || (props.files.length > 0 ? attachmentSubmitSentinel : ""),
          placeholder: props.placeholder,
          "onUpdate:modelValue": (value: string) =>
            emit("update:modelValue", value.replace(attachmentSubmitSentinel, "")),
          onSubmit: () => {
            const text = props.modelValue.trim();
            if (!text && props.files.length === 0) return;
            emit("submit", { files: props.files, text } satisfies AgentChatPromptSubmit);
          },
        },
        {
          header: () =>
            props.files.length > 0 || slots.files
              ? h(
                  "div",
                  { class: "vh-prompt__attachments" },
                  slots.files?.({ files: props.files, remove }) ??
                    props.files.map((file, index) =>
                      h(
                        "span",
                        { class: "vh-prompt__attachment", key: `${file.filename}-${index}` },
                        [
                          h("span", file.filename ?? file.mediaType),
                          h(
                            "button",
                            {
                              "aria-label": `Remove ${file.filename ?? "attachment"}`,
                              onClick: () => remove(index),
                              type: "button",
                            },
                            "×",
                          ),
                        ],
                      ),
                    ),
                )
              : null,
          footer: () =>
            h("div", { class: "vh-prompt__footer" }, [
              h("input", {
                accept: props.accept,
                "aria-label": "Add attachment",
                class: "vh-visually-hidden",
                multiple: props.multiple,
                onChange: async (event: Event) => {
                  const files = await Promise.all(
                    Array.from((event.target as HTMLInputElement).files ?? []).map(fileToUIPart),
                  );
                  emit("update:files", nextPromptFiles(props.files, files, props.multiple));
                  (event.target as HTMLInputElement).value = "";
                },
                ref: input,
                tabindex: -1,
                type: "file",
              }),
              slots.actions?.() ??
                h(UButton, {
                  "aria-label": "Add attachment",
                  color: "neutral",
                  icon: "i-lucide-paperclip",
                  onClick: () => input.value?.click(),
                  type: "button",
                  variant: "ghost",
                }),
              h("span", { class: "vh-prompt__spacer" }),
              slots.submit?.({ status: props.status }) ??
                h(UChatPromptSubmit, {
                  "aria-label": {
                    error: "Retry prompt",
                    ready: "Send prompt",
                    streaming: "Stop response",
                    submitted: "Stop response",
                  }[props.status],
                  onReload: () => emit("reload"),
                  status: props.status,
                  onStop: () => emit("stop"),
                }),
            ]),
        },
      );
  },
});
