// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentInvocation } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import { invocationActivities, invocationActivityTitle } from "../../src/console/runtime/components/invocation/internal/invocation-activity.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";
import { event, invocation, message, messageBodies, openDetails, openWork, threadRows, workText } from "./fixtures.ts";
import { loadMarkdown } from "./markdown.ts";

const show = (value: AgentInvocationView) => mount(AgentInvocation, { props: { invocation: value } });

/** A Teams message as the journal records it: the header line for the model, then the text. */
function teamsMessage(index: number, text: string, role = "user") {
  return {
    id: `msg-${index}`,
    parts: [
      { data: { modelText: `[Tue 2026-11-18 10:${String(index).padStart(2, "0")}:00 +01:00 · msg ${index} · from Ada Lovelace (id 29:1ada)]` }, id: "message-header", type: "data-chat-message-header" },
      { id: "text-0", text, type: "text" },
    ],
    role,
  };
}

function start(messages: readonly ReturnType<typeof teamsMessage>[], attributes: Record<string, unknown> = {}) {
  return event("agent.invocation.start", { "input.messages": messages, "input.trigger.message": messages.at(-1), ...attributes }, { sequence: 1 });
}

beforeAll(loadMarkdown);

describe("Agent Invocation Channel input", () => {
  it("shows the trigger message with its header on top of the conversation", () => {
    const history = [teamsMessage(1, "Is stable on the new tag?"), teamsMessage(2, "Yes.", "assistant")];
    const trigger = teamsMessage(3, "steer with the gergo message");
    const wrapper = show(invocation([
      start([...history, trigger]),
      message("assistant", "Done.", { "message.id": "answer" }, { sequence: 2 }),
    ]));
    expect(threadRows(wrapper).slice(0, 2)).toEqual(["history", "message"]);
    const prompt = wrapper.findAll(".vh-invocation-activities > li")[1]!;
    expect(prompt.get(".vh-invocation-message__header").text()).toBe("Tue 2026-11-18 10:03:00 +01:00 · msg 3 · from Ada Lovelace (id 29:1ada)");
    expect(prompt.get(".vh-invocation-message__body").text()).toBe("steer with the gergo message");
  });

  it("shows the trigger when it is not the last message of the history", () => {
    const trigger = teamsMessage(1, "Check the k8s values.");
    const later = teamsMessage(2, "Also check b11b.");
    const activities = invocationActivities(invocation([start([trigger, later], { "input.trigger.message": trigger })]));
    expect(activities.filter(activity => activity.attributes["message.trigger"] === true).map(activity => activity.body)).toEqual(["Check the k8s values."]);
  });

  it.each([1, 3])("does not treat a retained suffix as previous messages when the trigger was omitted (%i omitted)", (omitted) => {
    const trigger = teamsMessage(1, "Start here.");
    const later = teamsMessage(omitted + 1, "This came later.");
    const wrapper = show(invocation([start([later], { "input.trigger.message": trigger, "input.messages.omitted": omitted })]));
    expect(wrapper.find(".vh-invocation-history").exists()).toBe(false);
    expect(wrapper.get(".vh-invocation-message__body").text()).toBe("Start here.");
    const notice = wrapper.find(".vh-invocation-history__omitted");
    if (omitted > 1) expect(notice.text()).toBe("2 messages not recorded");
    else expect(notice.exists()).toBe(false);
  });

  it("shows a separately recorded trigger even when the journal omits the history field", () => {
    const trigger = teamsMessage(1, "Only the prompt was captured.");
    const wrapper = show(invocation([start([], { "input.messages": undefined, "input.trigger.message": trigger })]));
    expect(wrapper.get(".vh-invocation-message__body").text()).toBe("Only the prompt was captured.");
  });

  it("says how many earlier messages the journal did not record", async () => {
    const kept = Array.from({ length: 18 }, (_, index) => teamsMessage(index + 33, `Message ${index + 33}`));
    const wrapper = show(invocation([
      start(kept, { "input.messages.omitted": 32, "input.messages.total": 50 }),
      message("assistant", "Done.", {}, { sequence: 2 }),
    ]));
    const history = wrapper.get(".vh-invocation-history");
    expect(history.get("summary").text()).toContain("49 previous messages");
    await openDetails(history.get("details"));
    expect(history.get(".vh-invocation-history__omitted").text()).toBe("32 earlier messages not recorded");
    expect(messageBodies(history)).toHaveLength(17);
  });

  it("shows the omitted row when the trigger is the only recorded message", async () => {
    const wrapper = show(invocation([start([teamsMessage(50, "Message 50")], { "input.messages.omitted": 49, "input.messages.total": 50 })]));
    const history = wrapper.get(".vh-invocation-history");
    expect(history.get("summary").text()).toContain("49 previous messages");
    await openDetails(history.get("details"));
    expect(history.get(".vh-invocation-history__omitted").text()).toBe("49 earlier messages not recorded");
  });

  it.each([
    [{ "input.steer.outcome": "accepted" }, "Steer accepted", "completed"],
    [{ "input.steer.outcome": "deferred", "input.steer.reason": "unsupported" }, "Steer deferred: unsupported", "completed"],
    [{ "input.steer.outcome": "failed", "input.steer.reason": "invalid-state" }, "Steer failed: invalid-state", "failed"],
  ])("shows a steer attempt as a row of the work: %o", async (attributes, title, status) => {
    const steer = event("agent.input.steer", { "channel.delivery.id": "delivery-2", "input.steer.messageId": "msg-2", ...attributes }, { sequence: 3 });
    const value = invocation([
      start([teamsMessage(1, "Run it.")]),
      steer,
      message("assistant", "Done.", {}, { sequence: 4 }),
    ]);
    const row = invocationActivities(value).find(activity => activity.name === "agent.input.steer")!;
    expect(invocationActivityTitle(row)).toBe(title);
    expect(row.status).toBe(status);
    const wrapper = show(value);
    await openWork(wrapper);
    expect(workText(wrapper)).toContain(title);
  });
});
