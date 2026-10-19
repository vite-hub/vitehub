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

    const traces = wrapper.findAll("[data-slot=trace]");
    expect(traces).toHaveLength(1);
    const lines = traces[0]!.findAll("[data-slot=trace-line]");
    expect(lines.map((line) => line.get("[data-slot=trace-title]").text())).toEqual(["Thought", "run command", "lint", "pnpm docs"]);
    expect(lines[2]!.get("[data-slot=trace-description]").text()).toBe("Failed");
    expect(lines[2]!.attributes("data-status")).toBe("error");
    expect(traces[0]!.get("a[href='https://pnpm.io']").attributes("rel")).toBe("noreferrer");
    expect(wrapper.text()).toContain("The lockfile is out of date.");
  });

  it("shows a tool value that cannot be serialized without throwing", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const message = {
      id: "a",
      parts: [{ input: cyclic, state: "input-available", toolCallId: "t1", type: "tool-loop" }],
      role: "assistant",
    } as UIMessage;
    const wrapper = mount(ChatMessage, { attachTo: document.body, global, props: { message } });

    const line = wrapper.get("[data-slot=trace-line]");
    expect(line.attributes("data-status")).toBe("running");
    await wrapper.get("[data-slot=trace-collapsible-trigger]").trigger("click");
    expect(wrapper.get("[data-slot=code-block-content]").text()).toBe("[Value cannot be shown]");
    wrapper.unmount();
  });
});
