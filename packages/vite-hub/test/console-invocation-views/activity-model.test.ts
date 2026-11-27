import { describe, expect, it } from "vitest";
import { invocationActivities, invocationActivityTitle } from "../../src/console/runtime/components/invocation/internal/invocation-activity.ts";
import { delta, event, invocation, timestamp, tool } from "./fixtures.ts";

describe("Invocation activity model", () => {
  describe("messages", () => {
    it("shows durable input images beside text after reloading an invocation", () => {
      const activities = invocationActivities(invocation([event("agent.input", {
        "input.messages": [{ id: "input", role: "user", parts: [
          { type: "text", text: "What is this?" },
          { type: "image", name: "chart.png", url: "/files/retained-image" },
        ] }],
      })]));
      expect(activities.some(activity => activity.body?.includes("![chart.png](</files/retained-image>)"))).toBe(true);
      expect(activities.some(activity => activity.body?.includes("What is this?"))).toBe(true);
    });

    it("groups long message streams without losing delta order", () => {
      const count = 32_768;
      const letter = (index: number) => String.fromCharCode(97 + index % 26);
      const stream = invocation(Array.from({ length: count }, (_, index) => delta("assistant", letter(count - index - 1), { "message.id": "assistant" }, { sequence: count - index })));
      expect(invocationActivities(stream)).toEqual([
        expect.objectContaining({ body: Array.from({ length: count }, (_, index) => letter(index)).join(""), sequence: 1 }),
      ]);
    });

    it("keeps anonymous assistant turns on either side of a tool in sequence", () => {
      const activities = invocationActivities(invocation([delta("assistant", "before"), tool("finish", "tool-1", "shell"), delta("assistant", "after")]));
      expect(activities.map(activity => activity.body)).toEqual(["before", undefined, "after"]);
    });

    it.each(["input.messages", "input.prompt"])("preserves %s roles and turn boundaries", (attribute) => {
      const messages = [["system", "Follow the repository rules."], ["user", "Review this change."], ["assistant", "I found one issue."], ["tool", "The check passed."]] as const;
      const started = event("agent.invocation.started", { [attribute]: messages.map(([role, text]) => ({ id: role, parts: [{ text, type: "text" }], role })) });
      expect(invocationActivities(invocation([started])).map(activity => [activity.role, activity.body])).toEqual(messages);
    });

    it("keeps input history before the owning start event and retains structured turns", () => {
      const activities = invocationActivities(invocation([event("agent.invocation.start", {
        "input.messages": [
          { id: "user", parts: [{ text: "Run the check.", type: "text" }], role: "user" },
          { id: "tool", parts: [{ output: "passed", toolCallId: "call-1", type: "tool-result" }], role: "tool" },
        ],
        "runtime.name": "local",
      }, { sequence: 4 })], { status: "running" }));
      expect(activities.map(activity => [activity.role, activity.name])).toEqual([["user", "agent.input.message"], ["tool", "agent.input.message"]]);
      expect(activities[1]?.body).toContain('"tool-result"');
    });

    it.each([
      ["reused message IDs", [
        delta("assistant", "Checking.", { "message.id": "reply", "message.phase": "commentary" }),
        delta("assistant", "Done.", { "message.id": "reply", "message.phase": "final" }),
      ]],
      ["anonymous messages", [
        delta("assistant", "Check", { "message.phase": "commentary" }),
        delta("assistant", "ing.", { "message.phase": "commentary" }),
        delta("assistant", "Done.", { "message.phase": "final" }),
      ]],
    ])("keeps phased assistant text separate with %s", (_label, events) => {
      expect(invocationActivities(invocation(events)).map(activity => [activity.kind, activity.body])).toEqual([["message", "Checking."], ["message", "Done."]]);
    });

    it.each([
      ["does not replay an aggregate final answer after matching deltas", [
        delta("assistant", "Final "), delta("assistant", "answer."), event("agent.invocation.finish", { "result.text": "Final answer." }),
      ], [["agent.message.delta", "Final answer."]]],
      ["coalesces streamed deltas and omits duplicate terminal payloads", [
        delta("assistant", "Final "), delta("assistant", "answer"),
        event("agent.stream.finish", { "result.text": "Final answer" }), event("agent.invocation.finish", { "result.text": "Final answer" }),
      ], [["agent.message.delta", "Final answer"]]],
      ["keeps an aggregate final answer when no matching deltas exist", [
        event("agent.invocation.finish", { "result.text": "Final answer." }),
      ], [["agent.invocation.finish", "Final answer."]]],
    ])("%s", (_label, events, expected) => {
      expect(invocationActivities(invocation(events)).map(activity => [activity.name, activity.body])).toEqual(expected);
    });

    it("keeps public commentary between tools and omits the session start row", () => {
      const activities = invocationActivities(invocation([
        event("agent.invocation.started", { "runtime.name": "local" }),
        delta("assistant", "I found ", { "message.phase": "commentary" }),
        delta("assistant", "the issue.\n\nI’m checking the fix.", { "message.phase": "commentary" }),
        tool("start", "check", "shell", { "tool.input": { command: "pnpm test" } }),
      ], { status: "running" }));
      expect(activities.map(activity => [activity.kind, activity.body])).toEqual([
        ["message", "I found the issue.\n\nI’m checking the fix."],
        ["tool", "{\n  \"command\": \"pnpm test\"\n}"],
      ]);
    });
  });

  describe("commands and changes", () => {
    it.each([
      ["a direct output", { "tool.output": "clean" }, { command: "git status", output: "clean" }],
      ["a completed output", { "tool.output": { output: "clean" } }, { command: "git status", output: "clean" }],
      ["a direct provider payload", { "tool.output": { aggregatedOutput: "clean", exitCode: 0 } }, { command: "git status", exitCode: 0, output: "clean" }],
    ])("derives the command from %s", (_label, output, command) => {
      const activities = invocationActivities(invocation([
        tool("start", "command", "shell", { "tool.input": { command: "git status", cwd: "/workspace" } }),
        tool("finish", "command", "shell", output),
      ]));
      expect(activities[0]?.command).toEqual({ ...command, cwd: "/workspace" });
    });

    it.each(["agent.tool.finish", "agent.tool.error", "agent.tool.abort"])("preserves streamed Provider command output through %s", (terminalName) => {
      const terminalTimestamp = "2026-08-22T00:00:01.000Z";
      const activities = invocationActivities(invocation([
        tool("start", "command", "shell", { "tool.input": { command: "pnpm test" } }),
        tool("output", "command", "shell", { "tool.output": "first\n" }),
        tool("output", "command", "shell", { "tool.output": "second\n" }),
        tool("progress", "command", "shell", { "tool.output": { summary: "Still running" } }),
        event(terminalName, { "tool.id": "command", "tool.name": "shell", "tool.output": { detail: "terminal state" } }, { timestamp: terminalTimestamp }),
      ], { completedAt: "2026-08-22T00:00:03.000Z" }));
      expect(activities[0]).toMatchObject({ command: { output: "first\nsecond\n" }, durationMs: 1_000, endedAt: terminalTimestamp });
    });

    it("routes Provider turn diffs through the patch activity model", () => {
      const diff = "diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-old\n+new";
      const activities = invocationActivities(invocation([event("agent.turn.diff.updated", { "vitehub.activity.body": diff, "vitehub.activity.kind": "change" })]));
      expect(activities[0]).toMatchObject({ body: `${diff}\n`, kind: "change", patches: [`${diff}\n`], paths: ["src/old.ts"] });
    });

    it("renders canonical tool, error, and approval decision details", () => {
      const activities = invocationActivities(invocation([
        tool("start", "tool", "search", { "tool.input": { query: "agent UI" }, "tool.title": "airtable · search" }),
        tool("start", "tool", "search"),
        event("agent.tool.error", { "tool.durationMs": 42, "tool.error": "Search unavailable", "tool.id": "tool" }),
        event("agent.stream.error", { "error.message": "Recoverable stream error", "error.recoverable": true }),
        event("agent.approval.request", { "approval.id": "approval", "approval.name": "Run command" }, { type: "approval" }),
        event("agent.approval.decision", { "approval.approved": false, "approval.id": "approval", "approval.reason": "Command is destructive" }, { type: "approval" }),
      ]));
      expect(activities.map(activity => [invocationActivityTitle(activity), activity.body, activity.status])).toEqual([
        ["Airtable · search", "Search unavailable", "failed"],
        ["Approval denied", "Command is destructive", "failed"],
      ]);
    });

    it("models preparation and channel delivery observations as first-class activities", () => {
      const step = "vitehub.workspace.materialization:[\"docs\",\"\"]";
      const activities = invocationActivities(invocation([
        event("vitehub.workspace.materialization.start", { "step.id": step, "vitehub.activity.kind": "preparation", "vitehub.activity.title": "Materializing workspace" }),
        event("vitehub.workspace.materialization.completed", { "step.id": step, "vitehub.activity.kind": "preparation", "vitehub.activity.title": "Workspace materialized" }),
        event("vitehub.channel.delivery", { "channel.effect.intent": "started", "channel.effect.kind": "reaction" }),
      ], { status: "running" }));
      expect(activities.map(activity => activity.kind)).toEqual(["preparation", "delivery"]);
      expect(activities.map(invocationActivityTitle)).toEqual(["Workspace materialized", "Reacted with eyes"]);
      expect(activities[0]?.status).toBe("completed");
    });
  });

  describe("status and timing", () => {
    const task = (phase: string, attributes: Record<string, unknown> = {}, fields = {}) => event(`agent.task.${phase}`, { "step.id": "task", ...attributes }, fields);
    const shell = tool("start", "command", "shell", { "tool.input": { command: "pnpm test" } });

    it.each([
      ["a cancelled invocation settles an unfinished tool", [shell], "cancelled", "completed"],
      ["a failed invocation fails an unfinished tool", [shell], "failed", "failed"],
      ["a running invocation keeps a Provider task running", [task("started")], "running", "running"],
      ["a completed invocation completes a Provider task", [task("started")], "completed", "completed"],
      ["a failed invocation fails a Provider task", [task("started")], "failed", "failed"],
      ["a completion event completes a Provider task", [task("started"), task("completed")], "running", "completed"],
      ["a stop settles a Provider task while the invocation runs", [task("started"), task("cancelled")], "running", "completed"],
      ["an undecided approval request keeps running", [event("agent.approval.request", { "approval.id": "approval", "approval.name": "Run command" }, { type: "approval" })], "running", "running"],
    ] as const)("%s", (_label, events, status, activityStatus) => {
      expect(invocationActivities(invocation(events, { status }))[0]?.status).toBe(activityStatus);
    });

    it("bounds failed tasks by their observed failure", () => {
      const failedAt = "2026-08-22T00:00:01.000Z";
      const activities = invocationActivities(invocation(
        [task("started"), task("failed", { "error.message": "Task failed" }, { timestamp: failedAt })],
        { completedAt: "2026-08-22T00:00:03.000Z" },
      ));
      expect(activities[0]).toMatchObject({ durationMs: 1_000, endedAt: failedAt, status: "failed" });
    });

    it("extends running activities through the invocation update", () => {
      const updatedAt = "2026-08-22T00:00:03.000Z";
      const activities = invocationActivities(invocation([
        tool("start", "command", "shell"),
        tool("progress", "command", "shell", {}, { timestamp: "2026-08-22T00:00:01.000Z" }),
      ], { status: "running", updatedAt }));
      expect(activities[0]).toMatchObject({ durationMs: 3_000, endedAt: updatedAt, status: "running" });
    });

    it("uses the cancellation timestamp to end an unfinished tool", () => {
      const activities = invocationActivities(invocation(
        [tool("start", "search", "search", {}, { timestamp: "2026-08-22T00:01:00.000Z" })],
        { cancelledAt: "2026-08-22T00:01:05.000Z", startedAt: timestamp, status: "cancelled", updatedAt: "2026-08-22T00:01:05.000Z" },
      ));
      expect(activities[0]).toMatchObject({ durationMs: 5_000, endedAt: "2026-08-22T00:01:05.000Z", startedAt: "2026-08-22T00:01:00.000Z", status: "completed" });
    });
  });
});
