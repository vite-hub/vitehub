import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { AgentChat } from "../src/components/agent-chat.ts";
import { AgentInvocation, AgentInvocationInspector } from "../src/components/agent-invocation.ts";
import { AgentInvocationList } from "../src/components/agent-invocation-list.ts";
import type { AgentInvocationView } from "../src/types.ts";

describe("UI server rendering", () => {
  it("renders a coding-session list without owning navigation", async () => {
    const selected: string[] = [];
    const app = createSSRApp({
      render: () => h(AgentInvocationList, {
        items: [
          {
            agent: "babysitter",
            context: "PR #1015",
            id: "ainv_active",
            project: "vitehub",
            provider: "codex",
            status: "running",
            title: "Improve the coding session console",
            updatedAt: "2026-08-22T00:04:00.000Z",
          },
          {
            id: "ainv_done",
            project: "vitehub",
            status: "completed",
            title: "Publish the dashboard preview",
            updatedAt: "2026-08-22T00:00:00.000Z",
          },
        ],
        now: Date.parse("2026-08-22T00:08:00.000Z"),
        onSelect: item => selected.push(item.id),
        selectedId: "ainv_active",
      }),
    });
    const html = await renderToString(app);
    expect(html).toContain("Improve the coding session console");
    expect(html).toContain("Working");
    expect(html).toContain("4m");
    expect(html).not.toContain("Settled");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Publish the dashboard preview");
    expect(selected).toEqual([]);
  });

  it("renders AI SDK messages without browser globals", async () => {
    const app = createSSRApp({
      render: () =>
        h(AgentChat, {
          messages: [
            { id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" },
            {
              id: "assistant-1",
              parts: [{ text: "**Hello** back", type: "text" }],
              role: "assistant",
            },
          ],
        }),
    });
    app.component(
      "UChatMessage",
      defineComponent({
        props: ["id", "parts", "role"],
        setup(_props, { slots }) {
          return () => h("article", slots.body?.());
        },
      }),
    );
    const html = await renderToString(app);
    expect(html).toContain('data-message-id="assistant-1"');
    expect(html).toContain("<strong>Hello</strong>");
  });

  it("renders a persisted invocation as a coding session", async () => {
    const app = createSSRApp({
      render: () => {
        const invocation: AgentInvocationView = {
            agentName: "support",
            configuration: {
              agent: { name: "support", version: "1.0.0" },
              capabilities: [{ id: "workspace-shell" }],
              driver: { kind: "provider", provider: "t3" },
              instructions: ["Work through the repository carefully."],
              runtime: { name: "node" },
              tools: [{ name: "exec" }],
              workspace: { mode: "write", name: "support", sources: ["repository"] },
            },
            createdAt: "2026-08-22T00:00:00.000Z",
            id: "ainv_1",
            observations: [
              {
                name: "agent.invocation.start",
                sequence: 1,
                timestamp: "2026-08-22T00:00:00.000Z",
                trace: { id: "trace_1" },
                type: "run",
              },
              {
                attributes: { "message.role": "assistant", "result.text": "Inspecting the repository." },
                name: "agent.message.recorded",
                sequence: 2,
                timestamp: "2026-08-22T00:00:00.100Z",
                trace: { id: "trace_1" },
                type: "run",
              },
              {
                attributes: {
                  "tool.id": "tool_1",
                  "tool.name": "Ran command",
                  "tool.output": { item: { aggregatedOutput: "clean\n", command: "git status --short", cwd: "/workspace", exitCode: 0 } },
                },
                name: "agent.tool.finish",
                sequence: 3,
                timestamp: "2026-08-22T00:00:00.500Z",
                trace: { id: "trace_1" },
                type: "run",
              },
              {
                attributes: { "usage.totalTokens": 1_200 },
                name: "agent.usage.recorded",
                sequence: 4,
                timestamp: "2026-08-22T00:00:00.750Z",
                trace: { id: "trace_1" },
                type: "run",
              },
              {
                name: "agent.invocation.finish",
                sequence: 5,
                timestamp: "2026-08-22T00:00:01.000Z",
                trace: { id: "trace_1" },
                type: "run",
              },
            ],
            status: "completed",
            traceId: "trace_1",
            updatedAt: "2026-08-22T00:00:01.000Z",
          };
        return h("div", [
          h(AgentInvocation, { invocation }),
          h(AgentInvocationInspector, { invocation }),
        ]);
      },
    });
    const html = await renderToString(app);
    expect(html).toContain("support");
    expect(html).toContain("Completed");
    expect(html).toContain("Inspecting the repository.");
    expect(html).not.toContain("Assistant");
    expect(html).not.toContain("12:00 AM");
    expect(html).toContain("Ran command");
    expect(html).toContain("git status --short");
    expect(html).toContain(">1,200<");
    expect(html).toContain('data-icon="command"');
    expect(html).not.toContain("vh-invocation-event__dot");
    expect(html).toContain("workspace-shell");
    expect(html).toContain("Work through the repository carefully.");
    expect(html).toContain("repository");
    expect(html).toContain("Copy Trace ID");
    expect(html).toContain("Copy Invocation ID");
    expect(html).not.toContain("trace_1");
  });
});
