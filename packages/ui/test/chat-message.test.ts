// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import { ChatMessage } from "../src/components/chat-message.ts";

const UIcon = defineComponent({ props: { name: String }, setup: (props) => () => h("span", { "data-icon": props.name }) });
const global = { components: { UIcon } };
const user: UIMessage = { id: "u", parts: [{ text: "Hi", type: "text" }], role: "user" };
const assistant: UIMessage = { id: "a", parts: [{ text: "Hello", type: "text" }], role: "assistant" };

describe("ChatMessage", () => {
  it("previews relative image files while rejecting executable image URLs", () => {
    const message: UIMessage = {
      id: "images",
      role: "assistant",
      parts: [
        { filename: "retained.png", mediaType: "image/png", type: "file", url: "/files/retained-image" },
        { filename: "unsafe.png", mediaType: "image/png", type: "file", url: "javascript:alert(1)" },
      ],
    };
    const wrapper = mount(ChatMessage, {
      global: { components: { UModal: defineComponent({ setup: (_, { slots }) => () => slots.default?.() }) } },
      props: { message },
    });

    expect(wrapper.findAll("img").map(image => image.attributes("src"))).toEqual(["/files/retained-image"]);
    expect(wrapper.get('[aria-label="Preview retained.png"]').attributes("type")).toBe("button");
    expect(wrapper.text()).toContain("unsafe.png");
  });

  it("puts the user at the end in a bubble and the assistant at the start without one", () => {
    const userMessage = mount(ChatMessage, { global, props: { message: user } });
    const assistantMessage = mount(ChatMessage, { global, props: { message: assistant } });

    expect(userMessage.get("[data-slot=message]").attributes()).toMatchObject({
      "aria-label": "User message",
      "data-align": "end",
      "data-role": "user",
      id: "u",
    });
    expect(userMessage.get("[data-slot=bubble]").attributes()).toMatchObject({ "data-align": "end", "data-variant": "secondary" });
    expect(userMessage.get("[data-slot=bubble-content] [data-slot=message-parts]").text()).toBe("Hi");

    expect(assistantMessage.get("[data-slot=message]").attributes()).toMatchObject({ "aria-label": "Assistant message", "data-align": "start" });
    expect(assistantMessage.find("[data-slot=bubble]").exists()).toBe(false);
    expect(assistantMessage.get("[data-slot=message-content] > [data-slot=message-parts]").text()).toBe("Hello");
  });

  it("replaces the body with the default slot and places the header, avatar, and actions", () => {
    const wrapper = mount(ChatMessage, {
      global,
      props: { message: assistant },
      slots: {
        actions: () => h("button", "Copy"),
        default: () => h("em", "Custom"),
        header: () => "Reviewer",
        leading: () => "AI",
      },
    });

    expect(wrapper.get("[data-slot=message-content] em").text()).toBe("Custom");
    expect(wrapper.find("[data-slot=message-parts]").exists()).toBe(false);
    expect(wrapper.get("[data-slot=message-header]").text()).toBe("Reviewer");
    expect(wrapper.get("[data-slot=message-avatar]").text()).toBe("AI");
    expect(wrapper.get("[data-slot=message-footer] button").text()).toBe("Copy");
  });

  it("lets attributes override the accessible name and add classes", () => {
    const wrapper = mount(ChatMessage, { attrs: { "aria-label": "Your question", class: "mt-4" }, global, props: { message: user } });
    expect(wrapper.get("[data-slot=message]").attributes()).toMatchObject({ "aria-label": "Your question", class: "mt-4" });
  });

  it("groups reasoning, tool calls, and sources of a turn into one trace", () => {
    const message: UIMessage = {
      id: "a",
      parts: [
        { state: "done", text: "Check the lockfile.", type: "reasoning" },
        { input: { command: "pnpm install" }, output: { exitCode: 1 }, state: "output-available", toolCallId: "t1", type: "tool-run_command" },
        { errorText: "Lint failed", input: {}, state: "output-error", toolCallId: "t2", type: "tool-lint" },
        { sourceId: "s1", title: "pnpm docs", type: "source-url", url: "https://pnpm.io" },
        { text: "The lockfile is out of date.", type: "text" },
      ],
      role: "assistant",
    };
    const wrapper = mount(ChatMessage, { global, props: { message } });

    const traces = wrapper.findAll(".cht-trace");
    expect(traces).toHaveLength(1);
    const steps = traces[0]!.findAll(".cht-step");
    expect(steps.map((step) => step.get(".cht-title").text())).toEqual(["Thought", "run command", "lint", "pnpm docs"]);
    expect(steps[2]!.get(".cht-state").text()).toBe("Failed");
    expect(steps[2]!.attributes("data-status")).toBe("error");
    expect(traces[0]!.get("a[href='https://pnpm.io']").attributes("rel")).toBe("noreferrer");
    expect(wrapper.text()).toContain("The lockfile is out of date.");
  });

  it("shows a cyclic tool value without throwing", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const message = {
      id: "a",
      parts: [{ input: cyclic, state: "input-available", toolCallId: "t1", type: "tool-loop" }],
      role: "assistant",
    } as UIMessage;
    const wrapper = mount(ChatMessage, { attachTo: document.body, global, props: { message } });

    expect(wrapper.get(".cht-step").attributes("data-status")).toBe("running");
    expect(wrapper.get(".cht-value pre").text()).toBe('{\n  "self": "[Circular]"\n}');
    wrapper.unmount();
  });
});
