// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createSSRApp, h, nextTick } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import { AgentInvocationList } from "../src/components/agent-invocation-list.ts";
import { AgentInvocation, AgentInvocationInspector } from "../src/components/agent-invocation.ts";
import { AgentMessageParts } from "../src/components/agent-message-parts.ts";
import { invocationActivities, invocationActivityTitle } from "../src/internal/invocation-activity.ts";

import type { AgentInvocationView } from "../src/types.ts";

describe("Agent Invocation UI", () => {
  it("discloses traces truncated by the invocation journal", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "truncated",
      observations: [{
        attributes: { "vitehub.trace.truncated": true },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp,
        type: "lifecycle" as const,
      }],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation).every(activity => activity.truncated)).toBe(true);
  });

  it("discloses bounded ordinary observations", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "bounded-observation",
      observations: [{
        attributes: { "vitehub.observation.truncated": true },
        name: "tool.finish",
        sequence: 1,
        timestamp,
        type: "run" as const,
      }],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)).toEqual([
      expect.objectContaining({ truncated: true }),
    ]);
  });

  it("renders only HTTP source URLs as links", () => {
    const parts: UIMessage["parts"] = [
      { sourceId: "safe", type: "source-url", url: "https://example.com/reference" },
      { sourceId: "unsafe", title: "Unsafe source", type: "source-url", url: "javascript:alert(1)" },
      { sourceId: "unsupported", type: "source-url", url: "data:text/plain,source" },
    ];
    const wrapper = mount(AgentMessageParts, { props: { parts } });

    expect(wrapper.findAll("a").map(link => link.attributes("href"))).toEqual(["https://example.com/reference"]);
    expect(wrapper.text()).toContain("Unsafe source");
    expect(wrapper.text()).toContain("data:text/plain,source");
  });

  it("renders HTTP and package-generated data file URLs without executable schemes", () => {
    const parts: UIMessage["parts"] = [
      { filename: "safe.txt", mediaType: "text/plain", type: "file", url: "https://example.com/safe.txt" },
      { filename: "unsafe.txt", mediaType: "text/plain", type: "file", url: "javascript:alert(1)" },
      { filename: "inline.png", mediaType: "image/png", type: "file", url: "data:image/png;base64,c2FmZQ==" },
      { mediaType: "text/html", type: "file", url: "data:text/html,<script>alert(1)</script>" },
    ];
    const wrapper = mount(AgentMessageParts, { props: { parts } });

    expect(wrapper.findAll("a").map(link => link.attributes("href"))).toEqual([
      "https://example.com/safe.txt",
      "data:image/png;base64,c2FmZQ==",
    ]);
    expect(wrapper.findAll("img").map(image => image.attributes("src"))).toEqual(["data:image/png;base64,c2FmZQ=="]);
    expect(wrapper.findAll("a")[1]!.attributes("target")).toBeUndefined();
    expect(wrapper.text()).toContain("unsafe.txt");
    expect(wrapper.text()).toContain("inline.png");
    expect(wrapper.text()).toContain("text/html");
  });

  it("renders the working state with the loader-circle path", () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        items: [{ id: "running", status: "running", title: "Working session" }],
        virtual: false,
      },
    });

    expect(wrapper.get('[data-status="running"] .vh-invocation-list__state-icon path').attributes("d"))
      .toBe("M21 12a9 9 0 1 1-6.219-8.56");
  });

  it("reserves virtual row space for error descriptions", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        items: [
          { description: "The host stopped before this invocation finished.", id: "failed", status: "failed", title: "Failed session" },
          { id: "completed", status: "completed", title: "Completed session" },
        ],
      },
    });

    await nextTick();

    const rows = wrapper.findAll("li");
    expect(rows[0]!.attributes("style")).toContain("height: 106px");
    expect(rows[1]!.attributes("style")).toContain("transform: translateY(106px)");
  });

  it("renders configuration and delivery lifecycle events", async () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "lifecycle",
      observations: [
        {
          attributes: {
            "vitehub.agent.configuration": {
              capabilities: [{ id: "db" }, { id: "blob" }],
              driver: { model: { id: "claude-sonnet-4-5" } },
              tools: [{ name: "search" }],
            },
          },
          name: "vitehub.agent.configured",
          sequence: 1,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: { "channel.effect.kind": "telegram.message.sent", "vitehub.inspect.target": "workspace" },
          name: "agent.channel.delivery",
          sequence: 2,
          timestamp,
          type: "run" as const,
        },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    const activities = invocationActivities(invocation);
    expect(activities.map(activity => [activity.kind, invocationActivityTitle(activity)])).toEqual([
      ["system", "Agent configured"],
      ["delivery", "telegram.message.sent"],
    ]);

    const wrapper = mount(AgentInvocation, { props: { invocation } });
    expect(wrapper.get('[data-kind="system"] .vh-invocation-event__suffix').text()).toBe("claude-sonnet-4-5 · 2 capabilities · 1 tool");
    await wrapper.get('[data-kind="system"] .vh-invocation-event__summary').trigger("click");
    await wrapper.get('[data-kind="delivery"] .vh-invocation-event__summary').trigger("keydown", { key: " " });
    expect(wrapper.emitted("inspect")).toEqual([["agent"], ["workspace"]]);
  });

  it("collapses long user messages until requested", async () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "long-message",
      observations: [{
        attributes: { "message.content": "x".repeat(721), "message.id": "user", "message.role": "user" },
        name: "agent.message",
        sequence: 1,
        timestamp,
        type: "lifecycle" as const,
      }],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    const wrapper = mount(AgentInvocation, { props: { invocation } });
    expect(wrapper.get(".vh-invocation-message__content").attributes("data-collapsed")).toBe("true");
    expect(wrapper.get(".vh-invocation-message__more").text()).toBe("Read more");

    await wrapper.get(".vh-invocation-message__more").trigger("click");
    expect(wrapper.get(".vh-invocation-message__content").attributes("data-collapsed")).toBeUndefined();
    expect(wrapper.get(".vh-invocation-message__more").text()).toBe("Show less");
  });

  it("groups terminal work while keeping external effects and the final answer visible", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      cancelledAt: "2026-08-22T00:00:05.000Z",
      createdAt: timestamp,
      id: "completed-thread",
      observations: [
        { attributes: { "message.content": "Run it.", "message.id": "user", "message.role": "user" }, name: "agent.message", sequence: 1, timestamp, type: "lifecycle" as const },
        { attributes: { "tool.id": "shell", "tool.input": { command: "pnpm test" }, "tool.name": "shell" }, name: "agent.tool.start", sequence: 2, timestamp, type: "run" as const },
        { attributes: { "tool.id": "shell", "tool.output": "passed", "tool.name": "shell" }, name: "agent.tool.finish", sequence: 3, timestamp, type: "run" as const },
        { attributes: { "channel.effect.kind": "telegram.message.sent" }, name: "agent.channel.delivery", sequence: 4, timestamp, type: "run" as const },
        { attributes: { "message.content": "Done.", "message.id": "assistant", "message.role": "assistant" }, name: "agent.message", sequence: 5, timestamp, type: "lifecycle" as const },
      ],
      startedAt: timestamp,
      status: "cancelled" as const,
      traceId: "trace",
      updatedAt: "2026-08-22T00:00:09.000Z",
    } satisfies AgentInvocationView;

    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const rows = wrapper.findAll(".vh-invocation-activities > li");
    expect(rows.map(row => row.classes().find(name => name.startsWith("vh-invocation-") && name !== "vh-invocation-activities"))).toEqual([
      "vh-invocation-message",
      "vh-invocation-activity",
      "vh-invocation-work",
      "vh-invocation-message",
    ]);
    expect(rows[1]!.attributes("data-kind")).toBe("delivery");
    expect(wrapper.get(".vh-invocation-work__title").text()).toBe("Worked for 5s");
    expect(wrapper.get(".vh-invocation-work__activities").text()).toContain("Shell");
    expect(rows[3]!.text()).toContain("Done.");
  });

  it("keeps anonymous assistant turns on either side of a tool in sequence", () => {
    const base = { timestamp: "2026-08-22T00:00:00.000Z", type: "lifecycle" as const };
    const invocation = {
      createdAt: base.timestamp,
      id: "invocation",
      observations: [
        { ...base, attributes: { "message.content": "before", "message.role": "assistant" }, name: "agent.message.delta", sequence: 1 },
        { ...base, attributes: { "tool.id": "tool-1", "tool.name": "shell" }, name: "agent.tool.finish", sequence: 2 },
        { ...base, attributes: { "message.content": "after", "message.role": "assistant" }, name: "agent.message.delta", sequence: 3 },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: base.timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation).map(activity => activity.body)).toEqual([
      "before",
      undefined,
      "after",
    ]);
  });

  it("preserves input message roles and turn boundaries", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "invocation",
      observations: [{
        attributes: {
          "input.messages": [
            { id: "system", parts: [{ text: "Follow the repository rules.", type: "text" }], role: "system" },
            { id: "user", parts: [{ text: "Review this change.", type: "text" }], role: "user" },
            { id: "assistant", parts: [{ text: "I found one issue.", type: "text" }], role: "assistant" },
          ],
        },
        name: "agent.invocation.started",
        sequence: 1,
        timestamp,
        type: "lifecycle" as const,
      }],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation).map(activity => [activity.role, activity.body])).toEqual([
      ["system", "Follow the repository rules."],
      ["user", "Review this change."],
      ["assistant", "I found one issue."],
    ]);
  });

  it("derives commands from direct provider payloads", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "provider-command",
      observations: [
        {
          attributes: { "tool.id": "command", "tool.input": { command: "git status", cwd: "/workspace" }, "tool.name": "shell" },
          name: "agent.tool.start",
          sequence: 1,
          timestamp,
          type: "run" as const,
        },
        {
          attributes: { "tool.id": "command", "tool.output": { aggregatedOutput: "clean", exitCode: 0 }, "tool.name": "shell" },
          name: "agent.tool.finish",
          sequence: 2,
          timestamp,
          type: "run" as const,
        },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)[0]?.command).toEqual({
      command: "git status",
      cwd: "/workspace",
      exitCode: 0,
      output: "clean",
    });
  });

  it.each([
    ["direct output", "clean"],
    ["completed output", { output: "clean" }],
  ])("preserves Provider command %s", (_label, output) => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "provider-command",
      observations: [
        { attributes: { "tool.id": "command", "tool.input": { command: "git status" }, "tool.name": "shell" }, name: "agent.tool.start", sequence: 1, timestamp, type: "run" as const },
        { attributes: { "tool.id": "command", "tool.output": output, "tool.name": "shell" }, name: "agent.tool.finish", sequence: 2, timestamp, type: "run" as const },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)[0]?.command?.output).toBe("clean");
  });

  it.each(["agent.tool.finish", "agent.tool.error", "agent.tool.abort"])(
    "preserves streamed Provider command output through %s",
    (terminalName) => {
      const timestamp = "2026-08-22T00:00:00.000Z";
      const invocation = {
        createdAt: timestamp,
        id: "provider-command",
        observations: [
          { attributes: { "tool.id": "command", "tool.input": { command: "pnpm test" }, "tool.name": "shell" }, name: "agent.tool.start", sequence: 1, timestamp, type: "run" as const },
          { attributes: { "tool.id": "command", "tool.output": "first\n", "tool.name": "shell" }, name: "agent.tool.output", sequence: 2, timestamp, type: "run" as const },
          { attributes: { "tool.id": "command", "tool.output": "second\n", "tool.name": "shell" }, name: "agent.tool.output", sequence: 3, timestamp, type: "run" as const },
          { attributes: { "tool.id": "command", "tool.output": { summary: "Still running" }, "tool.name": "shell" }, name: "agent.tool.progress", sequence: 4, timestamp, type: "run" as const },
          { attributes: { "tool.id": "command", "tool.output": { detail: "terminal state" }, "tool.name": "shell" }, name: terminalName, sequence: 5, timestamp, type: terminalName.endsWith(".error") ? "error" as const : "run" as const },
        ],
        status: "completed" as const,
        traceId: "trace",
        updatedAt: timestamp,
      } satisfies AgentInvocationView;

      expect(invocationActivities(invocation)[0]?.command?.output).toBe("first\nsecond\n");
    },
  );

  it.each([
    ["cancelled", "completed"],
    ["failed", "failed"],
  ] as const)("settles unfinished activities when an invocation is %s", (status, activityStatus) => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: `unfinished-${status}`,
      observations: [{
        attributes: { "tool.id": "command", "tool.input": { command: "pnpm test" }, "tool.name": "shell" },
        name: "agent.tool.start",
        sequence: 1,
        timestamp,
        type: "run" as const,
      }],
      status,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)[0]?.status).toBe(activityStatus);
  });

  it.each([
    ["running", "running"],
    ["completed", "completed"],
    ["failed", "failed"],
  ] as const)("derives Provider task lifecycle status for a %s invocation", (status, activityStatus) => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: `task-${status}`,
      observations: [{
        attributes: { "step.id": "task" },
        name: "agent.task.started",
        sequence: 1,
        timestamp,
        type: "run" as const,
      }],
      status,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)[0]?.status).toBe(activityStatus);
  });

  it("completes a Provider task when its completion event arrives", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "task-completed",
      observations: [
        { attributes: { "step.id": "task" }, name: "agent.task.started", sequence: 1, timestamp, type: "run" as const },
        { attributes: { "step.id": "task" }, name: "agent.task.completed", sequence: 2, timestamp, type: "run" as const },
      ],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)[0]?.status).toBe("completed");
  });

  it("settles a stopped Provider task while its invocation keeps running", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "task-stopped",
      observations: [
        { attributes: { "step.id": "task" }, name: "agent.task.started", sequence: 1, timestamp, type: "run" as const },
        { attributes: { "step.id": "task" }, name: "agent.task.cancelled", sequence: 2, timestamp, type: "run" as const },
      ],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)[0]?.status).toBe("completed");
  });

  it("routes Provider turn diffs through the patch activity model", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const diff = "diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-old\n+new";
    const invocation = {
      createdAt: timestamp,
      id: "provider-diff",
      observations: [{
        attributes: { "vitehub.activity.body": diff, "vitehub.activity.kind": "change" },
        name: "agent.turn.diff.updated",
        sequence: 1,
        timestamp,
        type: "run" as const,
      }],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)[0]).toMatchObject({
      body: `${diff}\n`,
      kind: "change",
      patches: [`${diff}\n`],
      paths: ["src/old.ts"],
    });
  });

  it("keeps input history before the owning start event and retains structured turns", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "invocation",
      observations: [{
        attributes: {
          "input.messages": [
            { id: "user", parts: [{ text: "Run the check.", type: "text" }], role: "user" },
            { id: "tool", parts: [{ output: "passed", toolCallId: "call-1", type: "tool-result" }], role: "tool" },
          ],
          "runtime.name": "local",
        },
        name: "agent.invocation.start",
        sequence: 4,
        timestamp,
        type: "lifecycle" as const,
      }],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    const activities = invocationActivities(invocation);
    expect(activities.map(activity => [activity.role, activity.name])).toEqual([
      ["user", "agent.input.message"],
      ["tool", "agent.input.message"],
      [undefined, "agent.invocation.start"],
    ]);
    expect(activities[1]?.body).toContain('"tool-result"');
  });

  it("preserves prompt message roles and turn boundaries", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "invocation",
      observations: [{
        attributes: {
          "input.prompt": [
            { id: "system", parts: [{ text: "Follow the repository rules.", type: "text" }], role: "system" },
            { id: "user", parts: [{ text: "Review this change.", type: "text" }], role: "user" },
            { id: "assistant", parts: [{ text: "I found one issue.", type: "text" }], role: "assistant" },
          ],
        },
        name: "agent.invocation.started",
        sequence: 1,
        timestamp,
        type: "lifecycle" as const,
      }],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation).map(activity => [activity.role, activity.body])).toEqual([
      ["system", "Follow the repository rules."],
      ["user", "Review this change."],
      ["assistant", "I found one issue."],
    ]);
  });

  it("keeps phased assistant text separate when message IDs are reused", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "invocation",
      observations: [
        { attributes: { "message.content": "Checking.", "message.id": "reply", "message.phase": "commentary", "message.role": "assistant" }, name: "agent.message.delta", sequence: 1, timestamp, type: "lifecycle" as const },
        { attributes: { "message.content": "Done.", "message.id": "reply", "message.phase": "final", "message.role": "assistant" }, name: "agent.message.delta", sequence: 2, timestamp, type: "lifecycle" as const },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation).map(activity => [activity.kind, activity.body])).toEqual([
      ["reasoning", "Checking."],
      ["message", "Done."],
    ]);
  });

  it("keeps phased anonymous assistant text separate", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "invocation",
      observations: [
        { attributes: { "message.content": "Check", "message.phase": "commentary", "message.role": "assistant" }, name: "agent.message.delta", sequence: 1, timestamp, type: "lifecycle" as const },
        { attributes: { "message.content": "ing.", "message.phase": "commentary", "message.role": "assistant" }, name: "agent.message.delta", sequence: 2, timestamp, type: "lifecycle" as const },
        { attributes: { "message.content": "Done.", "message.phase": "final", "message.role": "assistant" }, name: "agent.message.delta", sequence: 3, timestamp, type: "lifecycle" as const },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation).map(activity => [activity.kind, activity.body])).toEqual([
      ["reasoning", "Checking."],
      ["message", "Done."],
    ]);
  });

  it("does not replay an aggregate final answer after matching deltas", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "invocation",
      observations: [
        { attributes: { "message.content": "Final ", "message.role": "assistant" }, name: "agent.message.delta", sequence: 1, timestamp, type: "lifecycle" as const },
        { attributes: { "message.content": "answer.", "message.role": "assistant" }, name: "agent.message.delta", sequence: 2, timestamp, type: "lifecycle" as const },
        { attributes: { "result.text": "Final answer." }, name: "agent.invocation.finish", sequence: 3, timestamp, type: "lifecycle" as const },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation).map(activity => activity.body)).toEqual(["Final answer."]);
  });

  it("keeps an aggregate final answer when no matching deltas exist", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "invocation",
      observations: [{
        attributes: { "result.text": "Final answer." },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp,
        type: "lifecycle" as const,
      }],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation).map(activity => activity.body)).toEqual(["Final answer."]);
  });

  it("renders canonical tool, error, and approval decision details", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "invocation",
      observations: [
        { attributes: { "tool.id": "tool", "tool.input": { query: "agent UI" }, "tool.name": "search" }, name: "agent.tool.start", sequence: 1, timestamp, type: "lifecycle" as const },
        { attributes: { "tool.error": "Search unavailable", "tool.id": "tool" }, name: "agent.tool.error", sequence: 2, timestamp, type: "error" as const },
        { attributes: { "error.message": "Recoverable stream error" }, name: "agent.stream.error", sequence: 3, timestamp, type: "error" as const },
        { attributes: { "approval.id": "approval", "approval.name": "Run command" }, name: "agent.approval.request", sequence: 4, timestamp, type: "approval" as const },
        { attributes: { "approval.approved": false, "approval.id": "approval", "approval.reason": "Command is destructive" }, name: "agent.approval.decision", sequence: 5, timestamp, type: "approval" as const },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    const activities = invocationActivities(invocation);
    expect(activities.map(activity => [invocationActivityTitle(activity), activity.body, activity.status])).toEqual([
      ["Search", "Search unavailable", "failed"],
      ["Agent stream", "Recoverable stream error", "failed"],
      ["Approval denied", "Command is destructive", "failed"],
    ]);
  });

  it("keeps an undecided approval request running", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "pending-approval",
      observations: [{
        attributes: { "approval.id": "approval", "approval.name": "Run command" },
        name: "agent.approval.request",
        sequence: 1,
        timestamp,
        type: "approval" as const,
      }],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)[0]?.status).toBe("running");
  });

  it("hydrates virtual invocation lists from the complete server-rendered list", async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `inv-${index}`,
      status: "completed" as const,
      title: `Invocation ${index}`,
    }));
    const render = () => h(AgentInvocationList, { items });
    const html = await renderToString(createSSRApp({ render }));
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createSSRApp({ render });

    app.mount(container);
    await nextTick();

    expect(warning.mock.calls.flat().join(" ")).not.toContain("Hydration");
    expect(error.mock.calls.flat().join(" ")).not.toContain("Hydration");
    app.unmount();
    container.remove();
    warning.mockRestore();
    error.mockRestore();
  });

  it("copies identifiers without displaying their full values", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const invocation: AgentInvocationView = {
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "sha256_invocation_identifier",
      observations: [],
      status: "completed",
      traceId: "sha256_trace_identifier",
      updatedAt: "2026-08-22T00:00:01.000Z",
    };
    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });

    expect(wrapper.text()).not.toContain(invocation.id);
    expect(wrapper.text()).not.toContain(invocation.traceId);
    await wrapper.get('button[aria-label="Copy Trace ID"]').trigger("click");
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(invocation.traceId);
    expect(wrapper.get('button[aria-label="Copied Trace ID"]').text()).toContain("Copied");
    wrapper.unmount();
  });

  it("keeps clipboard failures recoverable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("Denied");
        }),
      },
    });
    const invocation: AgentInvocationView = {
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "invocation",
      observations: [],
      status: "completed",
      traceId: "trace",
      updatedAt: "2026-08-22T00:00:01.000Z",
    };
    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });

    await wrapper.get('button[aria-label="Copy Trace ID"]').trigger("click");
    await Promise.resolve();

    expect(wrapper.get('button[aria-label="Copy Trace ID"]').text()).toContain("Copy");
  });

  it("surfaces the terminal error beside the exact status", () => {
    const invocation: AgentInvocationView = {
      createdAt: "2026-08-22T00:00:00.000Z",
      error: { message: "The provider stopped before returning a result.", name: "Provider error" },
      failedAt: "2026-08-22T00:00:05.000Z",
      id: "failed",
      observations: [],
      startedAt: "2026-08-22T00:00:00.000Z",
      status: "failed",
      traceId: "trace",
      updatedAt: "2026-08-22T00:00:05.000Z",
    };
    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });

    expect(wrapper.get('[role="status"]').text()).toContain("Failed");
    expect(wrapper.get(".vh-invocation-inspector__error").text()).toBe(
      "Provider errorThe provider stopped before returning a result.",
    );
  });

  it("uses the cancellation timestamp for terminal duration", () => {
    const invocation: AgentInvocationView = {
      cancelledAt: "2026-08-22T00:01:05.000Z",
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "cancelled",
      observations: [],
      startedAt: "2026-08-22T00:00:00.000Z",
      status: "cancelled",
      traceId: "trace",
      updatedAt: "2026-08-22T00:01:05.000Z",
    };

    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });
    expect(wrapper.get(".vh-invocation-inspector__status small").text()).toBe("1m 5s");
  });

  it("carries rounded duration seconds into minutes", () => {
    const invocation: AgentInvocationView = {
      completedAt: "2026-08-22T00:00:59.500Z",
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "completed",
      observations: [],
      startedAt: "2026-08-22T00:00:00.000Z",
      status: "completed",
      traceId: "trace",
      updatedAt: "2026-08-22T00:00:59.500Z",
    };

    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });
    expect(wrapper.get(".vh-invocation-inspector__status small").text()).toBe("1m 0s");
  });

  it("settles repeated page failures until the consumer changes the retry key", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      id: `inv-${index}`,
      status: "completed" as const,
      title: `Invocation ${index}`,
    }));
    const wrapper = mount(AgentInvocationList, {
      props: { hasMore: true, items, retryKey: 0 },
    });
    const viewport = wrapper.get("nav");
    Object.defineProperty(viewport.element, "scrollTop", {
      configurable: true,
      writable: true,
      value: 20 * 86,
    });

    await viewport.trigger("scroll");
    expect(wrapper.emitted("endReached")).toHaveLength(1);

    await wrapper.setProps({ loading: true });
    await wrapper.setProps({ loading: false });
    await wrapper.setProps({ loading: true });
    await wrapper.setProps({ loading: false });
    expect(wrapper.emitted("endReached")).toHaveLength(1);

    await wrapper.setProps({ retryKey: 1 });
    expect(wrapper.emitted("endReached")).toHaveLength(2);
  });

  it("formats token counts with a stable locale", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation: AgentInvocationView = {
      createdAt: timestamp,
      id: "tokens",
      observations: [{
        attributes: { "usage.reasoningTokens": 1_200, "usage.totalTokens": 12_345 },
        name: "agent.usage.recorded",
        sequence: 1,
        timestamp,
        type: "run",
      }],
      status: "completed",
      traceId: "trace",
      updatedAt: timestamp,
    };

    expect(mount(AgentInvocation, { props: { invocation } }).text()).toContain("1.2K tokens");
    expect(mount(AgentInvocationInspector, { props: { invocation } }).text()).toContain("12,345");
  });

  it("renders fallback dates in UTC for hydration stability", () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        items: [{ id: "old", status: "completed", title: "Old session", updatedAt: "2026-08-23T00:30:00.000Z" }],
        now: Date.parse("2026-08-25T00:30:00.000Z"),
        virtual: false,
      },
    });

    expect(wrapper.get("time").text()).toBe("Aug 23");
  });

  it("keeps virtual rows in list coordinates when a header precedes them", async () => {
    const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() { return this.classList.contains("vh-invocation-list__virtual") ? 1000 : 0; },
    });
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `inv-${index}`,
      status: "completed" as const,
      title: `Invocation ${index}`,
    }));
    const wrapper = mount(AgentInvocationList, {
      props: { items },
      slots: { header: "Header" },
    });
    const viewport = wrapper.get("nav");
    Object.defineProperty(viewport.element, "clientHeight", { configurable: true, value: 430 });
    Object.defineProperty(viewport.element, "scrollTop", { configurable: true, value: 1860 });

    await viewport.trigger("scroll");

    expect(wrapper.get("li").attributes("data-index")).toBe("4");
    wrapper.unmount();
    if (offsetTop) Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTop);
  });

  it("uses one flexible grid row when the host owns the header", () => {
    const invocation: AgentInvocationView = {
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "invocation",
      observations: [],
      status: "running",
      traceId: "trace",
      updatedAt: "2026-08-22T00:00:01.000Z",
    };
    const wrapper = mount(AgentInvocation, { props: { header: false, invocation } });

    expect(wrapper.get("article").classes()).toContain("vh-invocation-session--headerless");
  });

  it("coalesces streamed message deltas and omits duplicate terminal payloads", () => {
    const timestamp = "2026-08-24T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "streamed",
      observations: [
        { attributes: { "message.content": "Final ", "message.role": "assistant" }, name: "agent.message.delta", sequence: 1, timestamp, type: "lifecycle" as const },
        { attributes: { "message.content": "answer", "message.role": "assistant" }, name: "agent.message.delta", sequence: 2, timestamp, type: "lifecycle" as const },
        { attributes: { "result.text": "Final answer" }, name: "agent.stream.finish", sequence: 3, timestamp, type: "lifecycle" as const },
        { attributes: { "result.text": "Final answer" }, name: "agent.invocation.finish", sequence: 4, timestamp, type: "lifecycle" as const },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation).map(activity => [activity.name, activity.body])).toEqual([
      ["agent.message.delta", "Final answer"],
    ]);
  });

  it("models preparation and channel delivery observations as first-class activities", () => {
    const timestamp = "2026-08-24T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "lifecycle",
      observations: [
        {
          attributes: {
            "vitehub.activity.kind": "preparation",
            "vitehub.activity.title": "Workspace materialized",
          },
          name: "vitehub.workspace.materialized",
          sequence: 1,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: {
            "channel.effect.intent": "started",
            "channel.effect.kind": "reaction",
          },
          name: "vitehub.channel.delivery",
          sequence: 2,
          timestamp,
          type: "lifecycle" as const,
        },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    const activities = invocationActivities(invocation);
    expect(activities.map(activity => activity.kind)).toEqual(["preparation", "delivery"]);
    expect(activities.map(invocationActivityTitle)).toEqual(["Workspace materialized", "Reacted with eyes"]);
  });

  it("groups preparation, links the pull request, and emits inspector targets", async () => {
    const timestamp = "2026-08-24T00:00:00.000Z";
    const invocation = {
      annotations: {
        "github.pullRequest": 1030,
        "github.repository": "vite-hub/vitehub",
        "github.url": "https://github.com/vite-hub/vitehub/pull/1030",
      },
      completedAt: "2026-08-24T00:02:43.000Z",
      createdAt: timestamp,
      id: "prepared",
      observations: [
        {
          attributes: {
            "vitehub.activity.detail": "vite-hub/vitehub · PR #1030",
            "vitehub.activity.kind": "preparation",
            "vitehub.activity.title": "Pull request selected",
          },
          name: "vitehub.pull-request.selected",
          sequence: 1,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: {
            "vitehub.activity.detail": "1790 files",
            "vitehub.activity.kind": "preparation",
            "vitehub.activity.title": "Workspace materialized",
            "vitehub.inspect.target": "workspace",
          },
          name: "vitehub.workspace.materialized",
          sequence: 2,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: {
            "message.content": "Review this pull request. ".repeat(50),
            "message.id": "user",
            "message.role": "user",
          },
          name: "agent.message",
          sequence: 3,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: { "vitehub.activity.kind": "reasoning", "vitehub.activity.body": "Checked the diff." },
          name: "agent.reasoning.finish",
          sequence: 4,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: { "message.content": "Merged after checks passed.", "message.id": "assistant", "message.role": "assistant" },
          name: "agent.message",
          sequence: 5,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: {
            "channel.effect.intent": "started",
            "channel.effect.kind": "reaction",
            "vitehub.activity.group": "github-lifecycle",
          },
          name: "vitehub.channel.delivery",
          sequence: 6,
          timestamp,
          type: "lifecycle" as const,
        },
      ],
      startedAt: timestamp,
      status: "completed" as const,
      traceId: "trace",
      updatedAt: "2026-08-24T00:02:43.000Z",
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });

    expect(wrapper.get(".vh-invocation-preparation__summary").text()).toContain("Session prepared");
    expect(wrapper.get(".vh-invocation-preparation__summary").text()).toContain("2 steps");
    expect(wrapper.get('.vh-invocation-preparation__context a').attributes("href")).toBe(invocation.annotations["github.url"]);
    await wrapper.get(".vh-invocation-preparation__summary").trigger("click");
    await wrapper.get('button[aria-label="Open Workspace"]').trigger("click");
    expect(wrapper.emitted("inspect")).toEqual([["workspace"]]);

    const prompt = wrapper.get('.vh-invocation-message[data-role="user"]');
    expect(prompt.get(".vh-invocation-message__content").attributes("data-collapsed")).toBe("true");
    await prompt.get(".vh-invocation-message__more").trigger("click");
    expect(prompt.get(".vh-invocation-message__content").attributes("data-collapsed")).toBeUndefined();

    expect(wrapper.get(".vh-invocation-work__title").text()).toBe("Worked for 2m 43s");
    expect(wrapper.get('.vh-invocation-message[data-role="assistant"]').text()).toContain("Merged after checks passed.");
    expect(wrapper.get('.vh-invocation-lifecycle[data-activity-group="github-lifecycle"] .vh-invocation-lifecycle__emoji').text()).toBe("👀");
  });

  it("renders unsafe pull request annotations as text and failed preparation as failed", () => {
    const timestamp = "2026-08-24T00:00:00.000Z";
    const invocation = {
      annotations: {
        "github.pullRequest": 1040,
        "github.repository": "vite-hub/vitehub",
        "github.url": "javascript:alert(1)",
      },
      createdAt: timestamp,
      id: "failed-preparation",
      observations: [{
        attributes: {
          "error.message": "Workspace checkout failed",
          "vitehub.observation.truncated": true,
          "vitehub.activity.kind": "preparation",
          "vitehub.activity.title": "Workspace failed",
        },
        name: "vitehub.workspace.error",
        sequence: 1,
        timestamp,
        type: "error" as const,
      }],
      status: "failed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });

    expect(wrapper.get(".vh-invocation-preparation__summary").text()).toContain("Session preparation failed");
    expect(wrapper.find(".vh-invocation-preparation__context a").exists()).toBe(false);
    expect(wrapper.get(".vh-invocation-preparation__context").text()).toContain("PR #1040");
    expect(wrapper.get(".vh-invocation-preparation__body").text()).toBe("Workspace checkout failed");
    expect(wrapper.get(".vh-invocation-preparation__steps .vh-invocation-event__notice").text()).toContain("truncated");
  });

  it("preserves input transcript order when the latest user has no response", () => {
    const timestamp = "2026-08-24T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "unanswered-turn",
      observations: [{
        attributes: {
          "input.messages": [
            { id: "user-1", parts: [{ text: "First question", type: "text" }], role: "user" },
            { id: "assistant-1", parts: [{ text: "First answer", type: "text" }], role: "assistant" },
            { id: "user-2", parts: [{ text: "Unanswered question", type: "text" }], role: "user" },
          ],
        },
        name: "agent.invocation.started",
        sequence: 1,
        timestamp,
        type: "lifecycle" as const,
      }],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const messages = wrapper.findAll(".vh-invocation-message");

    expect(messages.map(message => message.text())).toEqual(["First question", "First answer", "Unanswered question"]);
    expect(wrapper.find(".vh-invocation-activities > .vh-invocation-message[data-role=\"assistant\"]").exists()).toBe(false);
  });

  it("renders grouped delivery outcomes, reaction intents, and truncation honestly", () => {
    const timestamp = "2026-08-24T00:00:00.000Z";
    const event = (sequence: number, attributes: Record<string, unknown>) => ({
      attributes: { "vitehub.activity.group": "github-lifecycle", "vitehub.activity.kind": "delivery", ...attributes },
      name: "vitehub.channel.delivery",
      sequence,
      timestamp,
      type: "lifecycle" as const,
    });
    const invocation = {
      createdAt: timestamp,
      id: "delivery-outcomes",
      observations: [
        event(1, { "channel.effect.kind": "reply", "channel.effect.supported": false }),
        event(2, { "channel.effect.kind": "status", "channel.effect.skipped": "missing target" }),
        event(3, { "channel.effect.intent": "completed", "channel.effect.kind": "reaction" }),
        event(4, { "channel.effect.intent": "failed", "channel.effect.kind": "reaction" }),
      ],
      observationsTruncated: true,
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });

    expect(wrapper.findAll(".vh-invocation-lifecycle__title").map(title => title.text())).toEqual([
      "Reply not supported",
      "Status skipped",
      "Reacted with hooray",
      "Reacted with confused",
    ]);
    expect(wrapper.findAll(".vh-invocation-lifecycle__emoji").map(emoji => [emoji.text(), emoji.attributes("aria-label")])).toEqual([
      ["🎉", "hooray"],
      ["😕", "confused"],
    ]);
    expect(wrapper.get(".vh-invocation-event__notice").text()).toContain("truncated");
  });

  it("exposes grouped lifecycle failures", () => {
    const timestamp = "2026-08-24T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "lifecycle-failures",
      observations: [{
        attributes: {
          "error.message": "GitHub rejected the label update",
          "github.label.name": "Agent: Working",
          "github.label.operation": "add",
          "vitehub.activity.group": "github-lifecycle",
          "vitehub.activity.kind": "action",
          "vitehub.activity.title": "Added label",
        },
        name: "vitehub.github.label.error",
        sequence: 1,
        timestamp,
        type: "error" as const,
      }],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const row = wrapper.get('[data-activity-group="github-lifecycle"] [data-status="failed"]');

    expect(row.get('[data-icon="error"]').attributes("data-icon")).toBe("error");
    expect(row.get(".vh-invocation-lifecycle__title").text()).toBe("Failed to add label");
    expect(row.get(".vh-invocation-lifecycle__failure").text()).toBe("GitHub rejected the label update");
    expect(row.get(".vh-invocation-lifecycle__label").text()).toBe("Agent: Working");
  });

  it("groups adjacent lifecycle activities after their observations collapse", () => {
    const timestamp = "2026-08-24T00:00:00.000Z";
    const observation = (sequence: number, step: string, phase: "started" | "completed") => ({
      attributes: {
        "step.id": step,
        "vitehub.activity.group": "github-lifecycle",
        "vitehub.activity.kind": "action",
        "vitehub.activity.title": step,
      },
      name: `vitehub.github.${step}.${phase}`,
      sequence,
      timestamp,
      type: "lifecycle" as const,
    });
    const invocation = {
      createdAt: timestamp,
      id: "collapsed-lifecycle",
      observations: [
        observation(1, "first", "started"),
        observation(2, "first", "completed"),
        observation(3, "second", "started"),
        observation(4, "second", "completed"),
      ],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });

    expect(wrapper.findAll('[data-activity-group="github-lifecycle"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-activity-group="github-lifecycle"] .vh-invocation-lifecycle__row')).toHaveLength(2);
  });

  it("groups consecutive lifecycle rows and renders structured GitHub labels", () => {
    const timestamp = "2026-08-24T00:00:00.000Z";
    const event = (sequence: number, attributes: Record<string, unknown>, name: string) => ({
      attributes: { "vitehub.activity.group": "github-lifecycle", ...attributes },
      name,
      sequence,
      timestamp,
      type: "lifecycle" as const,
    });
    const invocation = {
      createdAt: timestamp,
      id: "github-lifecycle",
      observations: [
        event(1, {
          "github.label.color": "d0d7de",
          "github.label.name": "Agent: Queued",
          "github.label.operation": "add",
          "vitehub.activity.kind": "action",
          "vitehub.activity.title": "Queued label added",
        }, "vitehub.github.label.queued"),
        event(2, {
          "github.label.color": "54aeff",
          "github.label.name": "Agent: Working",
          "github.label.operation": "add",
          "vitehub.activity.kind": "action",
          "vitehub.activity.title": "Working label added",
        }, "vitehub.github.label.working"),
        event(3, {
          "channel.effect.intent": "started",
          "channel.effect.kind": "status",
          "vitehub.activity.kind": "delivery",
          "vitehub.activity.title": "Working status posted",
        }, "vitehub.github.status.started"),
        event(4, {
          "channel.effect.intent": "started",
          "channel.effect.kind": "reaction",
          "vitehub.activity.kind": "delivery",
          "vitehub.activity.title": "Reacted with eyes",
        }, "vitehub.github.reaction.started"),
        {
          ...event(5, {
            "vitehub.activity.kind": "action",
            "vitehub.activity.title": "Working label removed",
          }, "vitehub.github.label.removed"),
          attributes: {
            "github.label.color": "54aeff",
            "github.label.name": "Agent: Working",
            "github.label.operation": "remove",
            "vitehub.activity.group": "github-completion",
            "vitehub.activity.kind": "action",
            "vitehub.activity.title": "Working label removed",
          },
        },
        {
          attributes: {
            "channel.effect.intent": "completed",
            "channel.effect.kind": "update",
            "vitehub.activity.group": "github-completion",
            "vitehub.activity.kind": "delivery",
            "vitehub.activity.title": "GitHub result posted",
          },
          name: "vitehub.github.status.finished",
          sequence: 6,
          timestamp,
          type: "lifecycle" as const,
        },
      ],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const groups = wrapper.findAll(".vh-invocation-lifecycle");

    expect(groups).toHaveLength(2);
    expect(groups[0]!.findAll(".vh-invocation-lifecycle__row")).toHaveLength(4);
    expect(groups[1]!.findAll(".vh-invocation-lifecycle__row")).toHaveLength(2);
    expect(groups[0]!.findAll(".vh-invocation-lifecycle__label").map(chip => chip.text())).toEqual([
      "Agent: Queued",
      "Agent: Working",
    ]);
    expect(groups[0]!.findAll(".vh-invocation-lifecycle__title").slice(0, 2).map(title => title.text())).toEqual([
      "Added label",
      "Added label",
    ]);
    expect(groups[0]!.get(".vh-invocation-lifecycle__label").attributes("style")).toContain("#d0d7de");
    expect(groups[0]!.get(".vh-invocation-lifecycle__emoji").text()).toBe("👀");
    expect(groups[1]!.get(".vh-invocation-lifecycle__title").text()).toBe("Removed label");
    expect(groups[1]!.get(".vh-invocation-lifecycle__label").attributes("data-operation")).toBe("remove");
  });

  it("groups recorded Agent Definition details as captured setup", () => {
    const invocation: AgentInvocationView = {
      configuration: {
        agent: { name: "babysitter" },
        capabilities: [{ id: "github" }],
        driver: { kind: "provider", model: { id: "gpt-5.6-sol", provider: "openai" } },
        instructions: ["Follow repository instructions."],
        runtime: { name: "node" },
        tools: [{ name: "exec" }],
        workspace: { mode: "write", name: "babysitter", sources: ["github:vite-hub/vitehub"] },
      },
      createdAt: "2026-08-24T00:00:00.000Z",
      id: "configured",
      observations: [],
      status: "completed",
      traceId: "trace",
      updatedAt: "2026-08-24T00:00:01.000Z",
    };
    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });

    expect(wrapper.get(".vh-invocation-inspector__content").text()).toContain("gpt-5.6-sol");
    expect(wrapper.get(".vh-invocation-inspector__content").text()).toContain("openai");
    expect(wrapper.get(".vh-invocation-inspector__content").text()).toContain("node");
    expect(wrapper.findAll(".vh-invocation-inspector__content > section h4").map(node => node.text())).toContain("Captured setup");
    expect(wrapper.get(".vh-invocation-inspector__groups").text()).toContain("Instructions");
  });
});
