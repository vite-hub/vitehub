// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import { Chat, chatActivity } from "../src/components/chat.ts";

const question: UIMessage = { id: "q", parts: [{ text: "How do I install Lumen?", type: "text" }], role: "user" };

function reply(...parts: UIMessage["parts"]): UIMessage {
  return { id: "a", parts, role: "assistant" };
}

const started = { data: { kind: "turn.started", value: {} }, id: "run", type: "data-agent-event" } as const;
const note = { state: "done", text: "I'll check the installation page.", type: "text" } as const;
const running = { input: { command: "cat install.md" }, state: "input-available", title: "cat install.md", toolCallId: "t1", type: "tool-command_execution" } as const;
const ran = { ...running, output: "# Install Lumen", state: "output-available" } as const;

describe("chatActivity", () => {
  it.each([
    ["the reply was submitted", [question], "submitted", "Working"],
    ["only events arrived", [question, reply(started)], "streaming", "Working"],
    ["a message ended and the next step has not started", [question, reply(started, note)], "streaming", "Working"],
    ["a tool finished", [question, reply(note, ran)], "streaming", "Working"],
    ["a tool runs, which its trace step shows", [question, reply(started, note, running)], "streaming", undefined],
    ["a tool waits for approval", [question, reply({ ...running, approval: { id: "ap" }, state: "approval-requested" })], "streaming", undefined],
    ["the model reasons", [question, reply({ state: "streaming", text: "", type: "reasoning" })], "streaming", undefined],
    ["text streams", [question, reply(ran, { state: "streaming", text: "Install", type: "text" })], "streaming", undefined],
    ["the reply is done", [question, reply(note)], "ready", undefined],
    ["the reply failed", [question, reply(note)], "error", undefined],
  ] satisfies [string, UIMessage[], Parameters<typeof chatActivity>[1], string | undefined][])("returns %s", (_, messages, status, label) => {
    expect(chatActivity(messages, status)).toBe(label);
  });
});

describe("Chat activity line", () => {
  it("shows one still line under the last message while the Agent works, then removes it", async () => {
    const wrapper = mount(Chat, { props: { messages: [question, reply(started)], status: "streaming" } });
    const content = wrapper.get("[data-slot=message-scroller-content]");

    expect(content.element.lastElementChild?.getAttribute("data-slot")).toBe("chat-status");
    expect(wrapper.get("[data-slot=chat-status]").attributes("role")).toBe("status");
    expect(wrapper.get("[data-slot=chat-status]").text()).toBe("Working");

    await wrapper.setProps({ messages: [question, reply(started, note, running)] });
    expect(wrapper.find("[data-slot=chat-status]").exists()).toBe(false);

    await wrapper.setProps({ messages: [question, reply(started, note, ran)] });
    expect(wrapper.findAll("[data-slot=chat-status]").map(line => line.text())).toEqual(["Working"]);

    await wrapper.setProps({ messages: [question, reply(started, note, ran, { state: "streaming", text: "Install", type: "text" })] });
    expect(wrapper.find("[data-slot=chat-status]").exists()).toBe(false);

    await wrapper.setProps({ status: "ready" });
    expect(wrapper.find("[data-slot=chat-status]").exists()).toBe(false);
  });

  it("lets the status slot draw the line and keeps it out of the message slots", () => {
    const wrapper = mount(Chat, {
      props: { messages: [question], status: "submitted" },
      slots: { status: ({ label }: { label: string }) => `Agent: ${label}` },
    });

    expect(wrapper.get("[data-slot=message-scroller-content]").text()).toContain("Agent: Working");
    expect(wrapper.text().match(/Agent: Working/g)).toHaveLength(1);
  });
});
