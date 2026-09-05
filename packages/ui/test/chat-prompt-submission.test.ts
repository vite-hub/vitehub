// @vitest-environment happy-dom

import type { ChatStatus, FileUIPart } from "ai";
import UButton from "@nuxt/ui/components/Button.vue";
import UChatPrompt from "@nuxt/ui/components/ChatPrompt.vue";
import UChatPromptSubmit from "@nuxt/ui/components/ChatPromptSubmit.vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatPrompt } from "../src/components/agent-chat-prompt.ts";
import * as attachments from "../src/composables/attachments.ts";

const filePart: FileUIPart = {
  filename: "notes.txt",
  mediaType: "text/plain",
  type: "file",
  url: "data:text/plain,notes",
};

async function renderPrompt(status: ChatStatus = "ready") {
  const wrapper = mount(AgentChatPrompt, {
    global: { components: { UButton, UChatPrompt, UChatPromptSubmit }, stubs: { UIcon: true } },
    props: { modelValue: "Read these notes", status },
  });
  await flushPromises();
  return wrapper;
}

async function pickFile(wrapper: Awaited<ReturnType<typeof renderPrompt>>) {
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, "files", {
    configurable: true,
    value: [new File(["notes"], "notes.txt", { type: "text/plain" })],
  });
  await input.trigger("change");
}

afterEach(() => vi.restoreAllMocks());

describe("AgentChatPrompt submission with Nuxt UI", () => {
  it.each(["submitted", "streaming", "error"] satisfies ChatStatus[])(
    "keeps Enter and form submission inert in the %s state without losing the draft",
    async (status) => {
      const wrapper = await renderPrompt(status);
      await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
      await wrapper.get("form").trigger("submit");
      expect(wrapper.emitted("submit")).toBeUndefined();
      expect(wrapper.get("textarea").element.value).toBe("Read these notes");

      const event = status === "error" ? "reload" : "stop";
      const label = status === "error" ? "Retry prompt" : "Stop response";
      await wrapper.get(`button[aria-label="${label}"]`).trigger("click");
      expect(wrapper.emitted(event)).toHaveLength(1);

      await wrapper.setProps({ status: "ready" });
      await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
      expect(wrapper.emitted("submit")).toEqual([[{ text: "Read these notes", files: [] }]]);
      wrapper.unmount();
    },
  );

  it("keeps IME composition and Shift+Enter out of submission", async () => {
    const wrapper = await renderPrompt();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", isComposing: true });
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", shiftKey: true });
    expect(wrapper.emitted("submit")).toBeUndefined();
    wrapper.unmount();
  });

  it("supports attachment-only submission through the real Nuxt UI guard", async () => {
    const wrapper = await renderPrompt();
    await wrapper.setProps({ modelValue: "", files: [filePart] });
    expect(wrapper.get('button[aria-label="Send prompt"]').attributes("disabled")).toBeUndefined();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("submit")).toEqual([[{ text: "", files: [filePart] }]]);
    wrapper.unmount();
  });

  it("waits for all concurrent attachment batches before allowing submission", async () => {
    const first = Promise.withResolvers<FileUIPart>();
    const second = Promise.withResolvers<FileUIPart>();
    vi.spyOn(attachments, "fileToUIPart")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const wrapper = await renderPrompt();
    await pickFile(wrapper);
    await pickFile(wrapper);

    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")).toBeUndefined();
    expect(wrapper.get('button[aria-label="Send prompt"]').attributes("disabled")).toBeDefined();

    first.resolve(filePart);
    await flushPromises();
    await wrapper.setProps({ files: [filePart] });
    expect(wrapper.get('button[aria-label="Send prompt"]').attributes("disabled")).toBeDefined();
    second.resolve({ ...filePart, filename: "second.txt" });
    await flushPromises();
    const files = [filePart, { ...filePart, filename: "second.txt" }];
    expect(wrapper.emitted("update:files")?.at(-1)).toEqual([files]);
    await wrapper.setProps({ files });

    expect(wrapper.get('button[aria-label="Send prompt"]').attributes("disabled")).toBeUndefined();
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")).toEqual([[{ text: "Read these notes", files }]]);
    wrapper.unmount();
  });

  it("restores submission after a read fails and preserves the draft and existing files", async () => {
    const pending = Promise.withResolvers<FileUIPart>();
    vi.spyOn(attachments, "fileToUIPart").mockReturnValue(pending.promise);
    const wrapper = await renderPrompt();
    await wrapper.setProps({ files: [filePart] });
    await pickFile(wrapper);
    const error = new Error("File read failed");
    pending.reject(error);
    await flushPromises();

    expect(wrapper.emitted("error")).toEqual([[error]]);
    expect(wrapper.emitted("update:files")).toBeUndefined();
    expect(wrapper.get('button[aria-label="Send prompt"]').attributes("disabled")).toBeUndefined();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("submit")).toEqual([[{ text: "Read these notes", files: [filePart] }]]);
    wrapper.unmount();
  });

  it.each(["streaming", "error"] satisfies ChatStatus[])(
    "keeps the %s action available during attachment preparation",
    async (status) => {
      const pending = Promise.withResolvers<FileUIPart>();
      vi.spyOn(attachments, "fileToUIPart").mockReturnValue(pending.promise);
      const wrapper = await renderPrompt(status);
      await pickFile(wrapper);
      const label = status === "error" ? "Retry prompt" : "Stop response";
      const button = wrapper.get(`button[aria-label="${label}"]`);
      expect(button.attributes("disabled")).toBeUndefined();
      await button.trigger("click");
      expect(wrapper.emitted(status === "error" ? "reload" : "stop")).toHaveLength(1);
      pending.resolve(filePart);
      await flushPromises();
      wrapper.unmount();
    },
  );

  it.each(["resolve", "reject"] as const)("does not emit after unmount when a file read settles via %s", async (result) => {
    const pending = Promise.withResolvers<FileUIPart>();
    vi.spyOn(attachments, "fileToUIPart").mockReturnValue(pending.promise);
    const wrapper = await renderPrompt();
    await pickFile(wrapper);
    wrapper.unmount();
    if (result === "resolve") pending.resolve(filePart);
    else pending.reject(new Error("File read failed"));
    await flushPromises();
    expect(wrapper.emitted("update:files")).toBeUndefined();
    expect(wrapper.emitted("error")).toBeUndefined();
  });
});
