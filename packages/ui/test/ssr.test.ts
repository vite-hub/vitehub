import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { AgentChat } from "../src/components/agent-chat.ts";
import { AgentInvocation } from "../src/components/agent-invocation.ts";

describe("UI server rendering", () => {
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

  it("renders a persisted invocation and derived trace", async () => {
    const app = createSSRApp({
      render: () =>
        h(AgentInvocation, {
          invocation: {
            agentName: "support",
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
                name: "agent.invocation.finish",
                sequence: 2,
                timestamp: "2026-08-22T00:00:01.000Z",
                trace: { id: "trace_1" },
                type: "run",
              },
            ],
            status: "completed",
            traceId: "trace_1",
            updatedAt: "2026-08-22T00:00:01.000Z",
          },
        }),
    });
    app.component(
      "UBadge",
      defineComponent({
        setup(_props, { slots }) {
          return () => h("span", slots.default?.());
        },
      }),
    );
    app.component(
      "UCollapsible",
      defineComponent({
        setup(_props, { slots }) {
          return () => h("div", [slots.default?.(), slots.content?.()]);
        },
      }),
    );
    const html = await renderToString(app);
    expect(html).toContain("support");
    expect(html).toContain("completed");
    expect(html).toContain("Trace trace_1");
  });
});
