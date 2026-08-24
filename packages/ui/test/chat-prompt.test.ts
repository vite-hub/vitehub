// @vitest-environment happy-dom

import type { ChatStatus } from "ai";
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
  setup(props, { attrs, emit, slots }) {
    const submit = (event: Event) => {
      event.preventDefault();
      if (props.modelValue.trim()) emit("submit", event);
    };
    return () =>
      h("form", { onSubmit: submit }, [
        h("textarea", {
          "aria-label": attrs["aria-label"],
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

const ButtonStub = defineComponent({
  setup(_props, { attrs, slots }) {
    return () => h("button", { ...attrs, type: "button" }, slots.default?.());
  },
});

const ChatPromptSubmitStub = defineComponent({
  inheritAttrs: false,
  props: { status: { default: "ready", type: String } },
  emits: ["reload", "stop"],
  setup(props, { attrs, emit }) {
    return () => h("button", {
      ...attrs,
      "data-submit": "",
      onClick: props.status === "error"
        ? () => emit("reload")
        : props.status === "ready"
          ? undefined
          : () => emit("stop"),
      type: "button",
    });
  },
});

const global = {
  components: {
    UButton: ButtonStub,
    UChatPrompt: TrimGuardPrompt,
    UChatPromptSubmit: ChatPromptSubmitStub,
  },
};

describe("AgentChatPrompt", () => {
  it("names the composer and keeps the programmatic picker out of the tab order", () => {
    const wrapper = mount(AgentChatPrompt, { global });

    expect(wrapper.get("textarea").attributes("aria-label")).toBe("Message");
    expect(wrapper.get('input[type="file"]').attributes()).toMatchObject({
      "aria-label": "Add attachment",
      tabindex: "-1",
    });
    expect(wrapper.get('button[aria-label="Add attachment"]')).toBeDefined();
  });

  it.each([
    ["ready", "Send prompt", undefined],
    ["submitted", "Stop response", "stop"],
    ["streaming", "Stop response", "stop"],
    ["error", "Retry prompt", "reload"],
  ] satisfies readonly [ChatStatus, string, "reload" | "stop" | undefined][])(
    "names and handles the %s submit state",
    async (status, label, emitted) => {
      const wrapper = mount(AgentChatPrompt, { global, props: { status } });
      const submit = wrapper.get("[data-submit]");

      expect(submit.attributes("aria-label")).toBe(label);
      await submit.trigger("click");
      if (emitted) expect(wrapper.emitted(emitted)).toHaveLength(1);
      else expect(wrapper.emitted("stop")).toBeUndefined();
    },
  );

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
