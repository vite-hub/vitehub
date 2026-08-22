// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";
import { AgentChatPrompt } from "../src/components/agent-chat-prompt.ts";

const TrimGuardPrompt = defineComponent({
  props: { modelValue: { default: "", type: String } },
  emits: ["submit", "update:modelValue"],
  setup(props, { emit, slots }) {
    const submit = (event: Event) => {
      event.preventDefault();
      if (props.modelValue.trim()) emit("submit", event);
    };
    return () =>
      h("form", { onSubmit: submit }, [
        h("textarea", {
          onInput: (event: Event) =>
            emit("update:modelValue", (event.target as HTMLTextAreaElement).value),
          onKeydown: (event: KeyboardEvent) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !event.isComposing
            ) {
              submit(event);
            }
          },
          value: props.modelValue,
        }),
        slots.header?.(),
        slots.footer?.(),
      ]);
  },
});

const EmptyStub = defineComponent({
  setup(_props, { slots }) {
    return () => h("span", slots.default?.());
  },
});

const global = {
  components: {
    UButton: EmptyStub,
    UChatPrompt: TrimGuardPrompt,
    UChatPromptSubmit: EmptyStub,
  },
};

describe("AgentChatPrompt", () => {
  it("passes attachment-only form and keyboard submissions through a text-only host guard", async () => {
    const wrapper = mount(AgentChatPrompt, {
      global,
      props: {
        files: [
          {
            filename: "notes.txt",
            mediaType: "text/plain",
            type: "file",
            url: "data:text/plain,notes",
          },
        ],
      },
    });

    expect(wrapper.find("textarea").element.value).not.toBe("");
    await wrapper.find("form").trigger("submit");
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });

    expect(wrapper.emitted("submit")?.map(([value]) => value)).toEqual([
      { files: wrapper.props("files"), text: "" },
      { files: wrapper.props("files"), text: "" },
    ]);
  });

  it("keeps empty prompts without attachments inert", async () => {
    const wrapper = mount(AgentChatPrompt, { global });

    await wrapper.find("form").trigger("submit");
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });

    expect(wrapper.emitted("submit")).toBeUndefined();
  });
});
