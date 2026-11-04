// @vitest-environment happy-dom

import type { ChatStatus } from "ai";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, effectScope, h } from "vue";
import { describe, expect, it, vi } from "vitest";
import { PromptInput } from "../src/components/prompt-input.ts";
import { ChatSession } from "../src/components/chat-session.ts";
import { nextPromptFiles } from "../src/internal/prompt-files.ts";
import { useAgentAttachments } from "../src/composables/attachments.ts";

describe("ChatSession", () => {
  it("keeps session header and footer slots out of message rendering", () => {
    const session = {
      id: "session-1",
      messages: [{ id: "message-1", parts: [{ text: "Hello", type: "text" as const }], role: "assistant" as const }],
      title: "Session",
    };
    const wrapper = mount(ChatSession, {
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

const global = {
  components: {
    UButton: ButtonStub,
    UIcon: defineComponent({ setup: () => () => h("span") }),
    UModal: defineComponent({ setup: (_, { slots }) => () => slots.default?.() }),
  },
};
const submitButton = '[data-slot="prompt-input-toolbar"] > button:last-child';

describe("PromptInput", () => {
  it("renders the leading footer slot before the prompt actions", () => {
    const wrapper = mount(PromptInput, {
      global,
      slots: {
        "footer-leading": () => h("span", { class: "footer-leading" }, "Profile"),
      },
    });

    expect(wrapper.get(".footer-leading").text()).toBe("Profile");
    expect(wrapper.html()).toContain('<span class="footer-leading">Profile</span>');
  });

  it("names the composer and keeps the programmatic picker out of the tab order", () => {
    const wrapper = mount(PromptInput, { global });

    expect(wrapper.get("textarea").attributes("aria-label")).toBe("Message");
    expect(wrapper.get('input[type="file"]').attributes()).toMatchObject({
      "aria-label": "Add attachment",
      tabindex: "-1",
    });
    expect(wrapper.get('[data-slot="prompt-input-toolbar"] > button:first-of-type').attributes("aria-label")).toBe("Add attachment");
    expect(wrapper.get(submitButton).attributes("aria-label")).toBe("Send prompt");
  });

  it("adds pasted images to the controlled files", async () => {
    const wrapper = mount(PromptInput, { global });
    const image = new File(["image"], "clipboard.png", { type: "image/png" });

    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [image], getData: () => "clipboard image" },
    });
    wrapper.get("textarea").element.dispatchEvent(event);
    await vi.waitFor(() => expect(wrapper.emitted("update:files")).toHaveLength(1));

    expect(event.defaultPrevented).toBe(true);
    expect(wrapper.emitted("update:files")?.at(-1)?.[0]).toEqual([
      {
        filename: "clipboard.png",
        mediaType: "image/png",
        type: "file",
        url: "data:image/png;base64,aW1hZ2U=",
      },
    ]);
  });

  it("renders a text-only prompt when attachments are off", async () => {
    const wrapper = mount(PromptInput, { global, props: { attachments: false } });
    const image = new File(["image"], "clipboard.png", { type: "image/png" });

    expect(wrapper.find('input[type="file"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Add attachment"]').exists()).toBe(false);

    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [image], getData: () => "" },
    });
    wrapper.get("textarea").element.dispatchEvent(event);
    await flushPromises();

    expect(event.defaultPrevented).toBe(false);
    expect(wrapper.emitted("update:files")).toBeUndefined();
  });

  it("leaves generic clipboard files alone when text is present", async () => {
    const wrapper = mount(PromptInput, { global });
    const document = new File(["notes"], "notes.txt", { type: "text/plain" });

    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [document], getData: () => "keep this text" },
    });
    wrapper.get("textarea").element.dispatchEvent(event);
    await flushPromises();

    expect(event.defaultPrevented).toBe(false);
    expect(wrapper.emitted("update:files")).toBeUndefined();
  });

  it("filters picker and pasted files before conversion", async () => {
    const filterFiles = vi.fn((): File[] => []);
    const wrapper = mount(PromptInput, { global, props: { filterFiles } });
    const picked = new File(["picked"], "picked.png", { type: "image/png" });
    const pasted = new File(["pasted"], "pasted.png", { type: "image/png" });
    const input = wrapper.get('input[type="file"]');
    Object.defineProperty(input.element, "files", { configurable: true, value: [picked] });

    await input.trigger("change");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [pasted], getData: () => "keep this text" },
    });
    wrapper.get("textarea").element.dispatchEvent(event);
    await flushPromises();

    expect(filterFiles.mock.calls).toEqual([[[picked]], [[pasted]]]);
    expect(event.defaultPrevented).toBe(false);
    expect(wrapper.emitted("update:files")).toBeUndefined();
  });

  it("reports attachment preparation errors", async () => {
    const error = new Error("could not prepare attachment");
    const wrapper = mount(PromptInput, {
      global,
      props: {
        filterFiles: () => {
          throw error;
        },
      },
    });
    const input = wrapper.get('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [new File(["image"], "broken.png", { type: "image/png" })],
    });

    await input.trigger("change");
    await flushPromises();

    expect(wrapper.emitted("error")).toEqual([[error]]);
  });

  it("previews image attachments above the editor with a separate remove control", async () => {
    const wrapper = mount(PromptInput, {
      global,
      props: {
        files: [
          {
            filename: "preview.png",
            mediaType: "image/png",
            type: "file",
            url: "data:image/png;base64,aW1hZ2U=",
          },
        ],
      },
    });

    expect(wrapper.get('[data-slot="attachment-media"][data-variant="image"] img').attributes()).toMatchObject({
      alt: "preview.png",
      src: "data:image/png;base64,aW1hZ2U=",
    });
    expect(wrapper.get('[aria-label="Preview preview.png"]').attributes("type")).toBe("button");
    expect(wrapper.find("button button").exists()).toBe(false);
    await wrapper.get('[aria-label="Remove preview.png"]').trigger("click");
    expect(wrapper.emitted("update:files")).toEqual([[[]]]);
    expect(wrapper.emitted("submit")).toBeUndefined();
  });

  it.each([
    ["ready", "Send prompt", undefined],
    ["submitted", "Stop response", "stop"],
    ["streaming", "Stop response", "stop"],
    ["error", "Retry prompt", "reload"],
  ] satisfies readonly [ChatStatus, string, "reload" | "stop" | undefined][])(
    "names and handles the %s submit state",
    async (status, label, emitted) => {
      const wrapper = mount(PromptInput, { global, props: { status } });
      const submit = wrapper.get(submitButton);

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

  it("keeps empty prompts without attachments inert", async () => {
    const wrapper = mount(PromptInput, { global });

    await wrapper.find("form").trigger("submit");
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });

    expect(wrapper.emitted("submit")).toBeUndefined();
  });
});
