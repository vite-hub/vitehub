// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createSSRApp, h, nextTick } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it, vi } from "vitest";
import { AgentInvocationList } from "../src/components/agent-invocation-list.ts";
import { AgentInvocation, AgentInvocationInspector } from "../src/components/agent-invocation.ts";
import { invocationActivities, invocationActivityTitle } from "../src/internal/invocation-activity.ts";

import type { AgentInvocationView } from "../src/types.ts";

describe("Agent Invocation UI", () => {
  it("discloses truncated invocation configuration", () => {
    const invocation: AgentInvocationView = {
      configuration: { instructions: ["partial"], truncated: true },
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "invocation",
      observations: [],
      status: "completed",
      traceId: "trace",
      updatedAt: "2026-08-22T00:00:01.000Z",
    };
    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });

    expect(wrapper.text()).toContain("Some configuration values were truncated");
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

    expect(invocationActivities(invocation).map(activity => activity.body)).toEqual(["Checking.", "Done."]);
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
    expect(wrapper.get('button[aria-label="Copy Trace ID"]').text()).toContain("Copied");
    wrapper.unmount();
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

  it("lets a user retry lazy loading by scrolling again after a failed page", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      id: `inv-${index}`,
      status: "completed" as const,
      title: `Invocation ${index}`,
    }));
    const wrapper = mount(AgentInvocationList, {
      props: { hasMore: true, items },
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
    await viewport.trigger("scroll");
    expect(wrapper.emitted("endReached")).toHaveLength(2);
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
});
