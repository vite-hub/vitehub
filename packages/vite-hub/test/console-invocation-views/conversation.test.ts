import { describe, expect, it } from "vitest";

import type { InvocationActivity } from "../../src/console/runtime/components/invocation/internal/invocation-activity.ts";
import { buildInvocationConversation } from "../../src/console/runtime/components/invocation/internal/invocation-conversation.ts";

function activity(sequence: number, fields: Partial<InvocationActivity> = {}): InvocationActivity {
  return {
    attributes: {},
    id: `activity-${sequence}`,
    kind: "tool",
    name: "agent.tool",
    patches: [],
    paths: [],
    sequence,
    status: "completed",
    ...fields,
  };
}

function message(sequence: number, role: InvocationActivity["role"], body: string, attributes = {}): InvocationActivity {
  return activity(sequence, { attributes, body, kind: "message", name: "agent.message", role });
}

function delivery(sequence: number, content: string, attributes = {}): InvocationActivity {
  return activity(sequence, {
    attributes: { "channel.effect.kind": "reply", "channel.effect.content": content, ...attributes },
    kind: "delivery",
    name: "agent.channel.delivery",
  });
}

describe("Invocation conversation plan", () => {
  it.each(["echo", "steer", "after-answer", "different-text", "truncated"])("handles the initial driver input %s without dropping later turns", (scenario) => {
    const prompt = message(1, "user", "Run it.", { "message.origin": "invocation-input", "message.id": "persisted" });
    prompt.name = "agent.input.message";
    const echo = message(3, "user", scenario === "different-text" ? "Different." : "Run it.", {
      "message.id": "driver-event",
      ...(scenario === "steer" ? { "input.mode": "steer" } : {}),
    });
    echo.name = "agent.input.message";
    echo.truncated = scenario === "truncated";
    const later = message(5, "user", "Run it.", { "message.id": "later-event" });
    later.name = "agent.input.message";
    const activities = [prompt, ...(scenario === "after-answer" ? [message(2, "assistant", "Earlier answer")] : []), echo, message(4, "assistant", "Answer"), later, message(6, "assistant", "Final answer")];
    const plan = buildInvocationConversation(activities);
    if (plan.kind !== "conversation") throw new Error("Expected a conversation");
    expect(plan.prompt).toBe(prompt);
    expect(plan.work.includes(echo)).toBe(scenario !== "echo");
    expect(plan.work).toContain(later);
  });

  it("keeps an unprompted activity stream and filters empty messages", () => {
    const activities = [message(1, "assistant", "  "), activity(2), message(3, "assistant", "Checking")];

    expect(buildInvocationConversation(activities)).toEqual({
      kind: "activities",
      activities: [activities[1], activities[2]],
      deliveredAnswerCount: 0,
      promptId: undefined,
    });
  });

  it("selects the current prompt and deduplicates delivered answers without matching against history", () => {
    const receipt = delivery(7, " Earlier reply ");
    const activities = [
      message(1, "user", "Earlier question"),
      message(2, "assistant", "Earlier reply"),
      activity(3, { name: "vitehub.agent.configured" }),
      message(4, "user", "Current question"),
      message(5, "user", "Keep going", { "input.mode": "steer" }),
      activity(6, { name: "vitehub.agent.configured" }),
      receipt,
      delivery(8, "Earlier reply"),
      delivery(9, " Done. "),
      message(10, "assistant", "Done."),
    ];
    activities[0]!.name = "agent.input.message";
    const plan = buildInvocationConversation(activities);

    expect(plan.kind).toBe("conversation");
    if (plan.kind !== "conversation") throw new Error("Expected a conversation");
    expect(plan.promptId).toBe("activity-4");
    expect(plan.prompt).toBe(activities[3]);
    expect(plan.history.map(item => item.id)).toEqual(["activity-1", "activity-2"]);
    expect(plan.work.map(item => item.id)).toEqual(["activity-5", "activity-6", "activity-7", "activity-8", "activity-9"]);
    expect(plan.work.filter(item => item.kind === "delivery").every(item => !("channel.effect.content" in item.attributes))).toBe(true);
    expect(plan.answers.map(item => [item.id, item.body])).toEqual([
      ["activity-7:answer", " Earlier reply "],
      ["activity-10", "Done."],
    ]);
    expect(plan.deliveredAnswerCount).toBe(1);
    expect(plan.followup).toEqual([]);
    expect(receipt.attributes["channel.effect.content"]).toBe(" Earlier reply ");
  });

  it("keeps a final answer before later commentary and deliveries", () => {
    const activities = [
      message(1, "user", "Question"),
      delivery(2, "First delivered reply"),
      message(3, "assistant", "Final answer"),
      message(4, "assistant", "One more check", { "message.phase": "commentary" }),
      delivery(5, "Later update", { "channel.effect.kind": "update" }),
      delivery(6, "Later update"),
    ];
    const plan = buildInvocationConversation(activities);

    if (plan.kind !== "conversation") throw new Error("Expected a conversation");
    expect(plan.answers.map(item => item.id)).toEqual(["activity-2:answer"]);
    expect(plan.followup.map(item => [item.id, item.body])).toEqual([
      ["activity-3", "Final answer"],
      ["activity-4", "One more check"],
      ["activity-5:answer", "Later update"],
    ]);
    expect(plan.work.map(item => item.id)).toEqual(["activity-2", "activity-5", "activity-6"]);
    expect(plan.deliveredAnswerCount).toBe(2);
  });

  it("preserves raw prompt metadata when an empty prompt is omitted from rendering", () => {
    const activities = [message(1, "user", " "), message(2, "user", "Visible question")];
    const plan = buildInvocationConversation(activities);

    if (plan.kind !== "conversation") throw new Error("Expected a conversation");
    expect(plan.promptId).toBe("activity-1");
    expect(plan.prompt?.id).toBe("activity-2");
  });

  it("shows delivery-only replies while excluding incomplete, unsupported, and skipped deliveries", () => {
    const activities = [
      delivery(1, "Sent"),
      delivery(2, "Unsupported", { "channel.effect.supported": false }),
      delivery(3, "Skipped", { "channel.effect.skipped": "Already sent" }),
      activity(4, { ...delivery(4, "Running"), status: "running" }),
      delivery(5, "Status", { "channel.effect.kind": "status" }),
    ];
    const plan = buildInvocationConversation(activities);

    if (plan.kind !== "conversation") throw new Error("Expected a conversation");
    expect(plan.prompt).toBeUndefined();
    expect(plan.answers.map(item => item.body)).toEqual(["Sent"]);
    expect(plan.deliveredAnswerCount).toBe(1);
    expect(plan.work).toHaveLength(5);
  });
});
