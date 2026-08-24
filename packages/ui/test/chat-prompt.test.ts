// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { defineComponent, effectScope, h } from "vue";
import { describe, expect, it } from "vitest";
import { AgentChatPrompt } from "../src/components/agent-chat-prompt.ts";
import { AgentSession } from "../src/components/agent-session.ts";
import { nextPromptFiles } from "../src/internal/prompt-files.ts";
import { useAgentAttachments } from "../src/composables/attachments.ts";

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

describe("AgentSession", () => {
  it("keeps session header and footer slots out of message rendering", () => {
    const session = {
      id: "session-1",
      messages: [{ id: "message-1", parts: [{ text: "Hello", type: "text" as const }], role: "assistant" as const }],
      title: "Session",
    };
    const wrapper = mount(AgentSession, {
      global: {
        components: {
          UChatMessage: defineComponent({
            setup(_props, { slots }) {
              return () => h("article", [slots.header?.(), slots.body?.()]);
            },
          }),
        },
      },
      props: { session },
      slots: {
        header: ({ session: value }: { session: typeof session }) => h("div", { class: "session-header" }, value.title),
      },
    });

    expect(wrapper.findAll(".session-header")).toHaveLength(1);
    expect(wrapper.text()).toContain("Session");
  });
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
  it("accepts multiple attachments by default", () => {
    const scope = effectScope();
    const attachments = scope.run(() => useAgentAttachments());
    if (!attachments) throw new Error("Expected attachment state.");
    attachments.add([
      new File(["first"], "first.txt", { type: "text/plain" }),
      new File(["second"], "second.txt", { type: "text/plain" }),
    ]);

    expect(attachments.inputProps.value.multiple).toBe(true);
    expect(attachments.files.value.map(({ file }) => file.name)).toEqual(["first.txt", "second.txt"]);
    scope.stop();
  });

  it("replaces the controlled attachment when multiple files are disabled", () => {
    const oldFile = { filename: "old.txt", mediaType: "text/plain", type: "file" as const, url: "data:,old" };
    const newFile = { filename: "new.txt", mediaType: "text/plain", type: "file" as const, url: "data:,new" };

    expect(nextPromptFiles([oldFile], [newFile], false)).toEqual([newFile]);
  });

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
