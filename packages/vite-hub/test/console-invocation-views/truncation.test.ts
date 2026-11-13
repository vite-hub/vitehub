// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { AgentInvocation, AgentInvocationInspector } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import { invocationActivities } from "../../src/console/runtime/components/invocation/internal/invocation-activity.ts";
import { delivery, delta, event, invocation, message, notices, openWork, receipts, runSummary, threadRows, tool } from "./fixtures.ts";

const shortened = "Part of this activity was shortened when it was recorded.";

describe("Invocation truncation", () => {
  it("discloses traces truncated by the invocation journal", () => {
    const truncated = invocation([event("agent.invocation.finish", { "vitehub.trace.truncated": true })]);
    const activities = invocationActivities(truncated);
    expect(activities.slice(0, -1).every(activity => activity.truncated === undefined)).toBe(true);
    expect(activities.at(-1)).toMatchObject({ id: "trace-truncated", kind: "system", name: "vitehub.observation.truncated", sequence: 2, status: "completed" });
    expect(invocationActivities(invocation([], { observationsTruncated: true }))).toEqual([
      expect.objectContaining({ id: "trace-truncated", kind: "system", sequence: 0 }),
    ]);
  });

  it("discloses bounded ordinary observations", () => {
    const bounded = invocation([event("tool.finish", { "vitehub.observation.truncated": true })]);
    const activities = invocationActivities(bounded);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ truncated: true });
    expect(mount(AgentInvocation, { props: { invocation: bounded } }).text()).toContain(shortened);
    const inspector = mount(AgentInvocationInspector, { props: { invocation: bounded } });
    expect(runSummary(inspector).Steps).toBe("1");
    const timelineRows = inspector.findAll(".vh-invocation-timeline__row");
    expect(timelineRows).toHaveLength(1);
    expect(timelineRows[0]!.text()).not.toContain("Trace content was truncated");
  });

  it("keeps nested truncation local to its activity", () => {
    const activities = invocationActivities(invocation([tool("finish", "check", "shell", { "vitehub.observation.truncated": true })]));
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ id: "check", truncated: true });
    expect(activities.some(activity => activity.id === "trace-truncated")).toBe(false);
  });

  it("names the shortened value and ignores shortened metadata", () => {
    const named = invocation([
      delta("assistant", "Finding symlinks", {
        "agent.run.id": "run", "message.id": "commentary", "message.phase": "commentary",
        "vitehub.observation.truncated": true, "vitehub.observation.truncatedAttributes": ["agent.run.id"],
      }),
      tool("finish", "read", "read_file", {
        "tool.output": "partial", "vitehub.observation.truncated": true, "vitehub.observation.truncatedAttributes": ["agent.run.id", "tool.output"],
      }),
    ]);
    const activities = invocationActivities(named);
    expect(activities.find(activity => activity.kind === "message")?.truncated).toBeUndefined();
    expect(activities.find(activity => activity.id === "read")).toMatchObject({ truncated: true, truncatedAttributes: ["tool.output"] });
    expect(notices(mount(AgentInvocation, { props: { invocation: named } }))).toEqual(["Output shortened when recorded."]);
  });

  it.each([
    ["reply", false],
    ["reply", true],
    ["update", false],
    ["update", true],
  ] as const)("discloses %s truncation beside its visible body (named: %s)", async (kind, named) => {
    const wrapper = mount(AgentInvocation, { props: { invocation: invocation([delivery({
      "channel.effect.content": "Bounded reply.",
      "channel.effect.kind": kind,
      "vitehub.observation.truncated": true,
      ...(named ? { "vitehub.observation.truncatedAttributes": ["channel.effect.content"] } : {}),
    })]) } });
    const answer = wrapper.get('.vh-invocation-message[data-role="assistant"]');
    await openWork(wrapper);
    const [receipt] = receipts(wrapper);

    expect(answer.get(".vh-invocation-message__body").text()).toBe("Bounded reply.");
    expect(notices(answer)).toEqual([named ? "Delivered text shortened when recorded." : shortened]);
    expect(receipt!.text()).not.toContain("Bounded reply.");
    expect(notices(receipt!).length > 0).toBe(!named);
  });

  it.each(["commentary", "user"] as const)("does not use an earlier response after later %s", (laterMessage) => {
    const activities = invocationActivities(invocation([
      delta("assistant", JSON.stringify({ text: "Done" }), { "message.id": "earlier", "message.phase": "final" }),
      delta(laterMessage === "user" ? "user" : "assistant", "Check again", { "message.id": "later", "message.phase": laterMessage === "commentary" ? "commentary" : undefined }),
      event("agent.invocation.finish", { "result.text": "Done", "vitehub.observation.truncated": true }),
    ]));
    expect(activities.find(activity => activity.name === "agent.invocation.finish")?.truncated).toBe(true);
  });

  it.each([
    { sourceText: JSON.stringify({ disposition: "complete", text: "Final answer." }), sourceTruncated: false, expectedTruncated: false },
    { sourceText: JSON.stringify({ disposition: "complete", text: "Final answer." }), sourceTruncated: true, expectedTruncated: true },
    { sourceText: JSON.stringify({ text: "Different answer." }), sourceTruncated: false, expectedTruncated: true },
    { sourceText: '{"text":"Final answer."', sourceTruncated: false, expectedTruncated: true },
  ].flatMap(testCase => [10, testCase.sourceText.indexOf(" answer"), testCase.sourceText.indexOf(" answer") + 1]
    .filter(splitAt => splitAt > 0)
    .map(splitAt => ({ ...testCase, splitAt }))))("checks preserved response content before applying a finish metadata warning: $expectedTruncated ($sourceText, $sourceTruncated, $splitAt)", ({ sourceText, sourceTruncated, expectedTruncated, splitAt }) => {
    const finished = invocation([
      delta("assistant", "Checking the branch.", { "message.phase": "commentary" }),
      delta("assistant", sourceText.slice(0, splitAt), { "message.phase": "final" }),
      delta("assistant", sourceText.slice(splitAt), { "message.phase": "final", "vitehub.observation.truncated": sourceTruncated }),
      event("agent.invocation.finish", { "result.text": "Final answer.", "result.kind": "object", "usage.record": { raw: "[Truncated]" }, "vitehub.observation.truncated": true }),
    ], { observationsTruncated: true });
    const activities = invocationActivities(finished);
    const result = activities.find(activity => activity.name === "agent.invocation.finish");
    expect(result?.body).toBe("Final answer.");
    expect(result?.truncated === true).toBe(expectedTruncated);
    expect(activities.some(activity => activity.name === "vitehub.observation.truncated")).toBe(true);
    const wrapper = mount(AgentInvocation, { props: { invocation: finished } });
    expect(wrapper.findAll('[data-role="assistant"]').some(answer => notices(answer).length > 0)).toBe(expectedTruncated);
  });

  it.each([
    ["input.messages", false],
    ["input.messages", true],
    ["input.prompt", true],
  ])("preserves %s order when the latest user has no response (truncated: %s)", (attribute, truncated) => {
    const unanswered = invocation([event("agent.invocation.started", {
      [attribute]: [
        { id: "user-1", parts: [{ text: "First question", type: "text" }], role: "user" },
        { id: "assistant-1", parts: [{ text: "First answer", type: "text" }], role: "assistant" },
        { id: "user-2", parts: [{ text: "Unanswered question", type: "text" }], role: "user" },
      ],
      ...(truncated ? { "vitehub.observation.truncated": true } : {}),
    })]);
    const wrapper = mount(AgentInvocation, { props: { invocation: unanswered } });
    const messages = wrapper.findAll(".vh-invocation-message");

    expect(messages.map(item => item.get(".vh-invocation-message__content").text())).toEqual(["First question", "First answer", "Unanswered question"]);
    expect(messages.at(-1)!.attributes("data-role")).toBe("user");
    if (!truncated) return;
    expect(messages.at(-1)!.text()).toContain(shortened);
    expect(invocationActivities(unanswered).filter(activity => activity.name === "agent.input.message"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ truncated: true })]));
  });

  it("renders truncation after work when the latest user has no response", () => {
    const wrapper = mount(AgentInvocation, { props: { invocation: invocation([
      message("user", "Unanswered question", { "message.id": "user" }),
      event("agent.tool.error", { "error.message": "Model request failed", "tool.name": "generate" }),
    ], { observationsTruncated: true, status: "failed" }) } });

    expect(threadRows(wrapper).at(-1)).toBe("work");
    expect(wrapper.find('[data-activity-id="trace-truncated"]').exists()).toBe(false);
  });
});
