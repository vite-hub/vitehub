// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createSSRApp, defineComponent, h, nextTick } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import { AgentInvocationList } from "../src/components/agent-invocation-list.ts";
import { AgentInvocation, AgentInvocationInspector } from "../src/components/agent-invocation.ts";
import { AgentMessageParts } from "../src/components/agent-message-parts.ts";
import { invocationActivities, invocationActivityTitle } from "../src/internal/invocation-activity.ts";

import type { AgentInvocationView } from "../src/types.ts";

describe("Agent Invocation UI", () => {
  it("places one semantic run timestamp before the session activities and falls back to creation time", () => {
    const invocation: AgentInvocationView = { id: "time", status: "completed", traceId: "trace", createdAt: "2026-09-05T10:00:00Z", startedAt: "2026-09-05T10:01:00Z", updatedAt: "2026-09-05T10:02:00Z", observations: [] };
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const time = wrapper.get("time");
    expect(time.attributes("datetime")).toBe("2026-09-05T10:01:00.000Z");
    expect(time.element.nextElementSibling?.getAttribute("role")).toBe("log");
    expect(wrapper.findAll("time")).toHaveLength(1);
    const fallback = mount(AgentInvocation, { props: { invocation: { ...invocation, startedAt: "invalid" } } });
    expect(fallback.get("time").attributes("datetime")).toBe("2026-09-05T10:00:00.000Z");
  });

  it("groups recorded tools under their capability without inventing ownership", () => {
    const wrapper = mount(AgentInvocationInspector, { props: { invocation: {
      id: "tools", status: "completed", traceId: "trace", createdAt: "2026-09-05T10:00:00Z", updatedAt: "2026-09-05T10:00:00Z", observations: [],
      configuration: { capabilities: [{ id: "files" }], tools: [{ name: "read", capabilityId: "files", description: "Read exact bytes." }, { name: "native", description: "Provider tool." }] },
    } } });
    const capability = wrapper.findAll("details").find(item => item.find("summary").text().startsWith("files"))!;
    expect(capability.text()).toContain("Read exact bytes.");
    expect(capability.text()).not.toContain("Provider tool.");
    expect(wrapper.text()).toContain("Provider tool.");
  });

  it("shows durable input images beside text after reloading an invocation", () => {
    const timestamp = "2026-09-05T00:00:00.000Z";
    const activities = invocationActivities({
      id: "image", createdAt: timestamp, updatedAt: timestamp, status: "completed", traceId: "trace",
      observations: [{ name: "agent.input", type: "run", timestamp, sequence: 1, attributes: {
        "input.messages": [{ id: "input", role: "user", parts: [
          { type: "text", text: "What is this?" },
          { type: "image", name: "chart.png", url: "/files/retained-image" },
        ] }],
      } }],
    });
    expect(activities.some(activity => activity.body?.includes("![chart.png](</files/retained-image>)"))).toBe(true);
    expect(activities.some(activity => activity.body?.includes("What is this?"))).toBe(true);
  });

  it("groups long message streams without losing delta order", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const observationCount = 32_768;
    const invocation = {
      createdAt: timestamp,
      id: "long-message-stream",
      observations: Array.from({ length: observationCount }, (_, index) => {
        const sequence = observationCount - index;
        return {
          attributes: {
            "message.content": String.fromCharCode(97 + (sequence - 1) % 26),
            "message.id": "assistant",
            "message.role": "assistant",
          },
          name: "agent.message.delta",
          sequence,
          timestamp,
          type: "run" as const,
        };
      }),
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)).toEqual([
      expect.objectContaining({
        body: Array.from(
          { length: observationCount },
          (_, index) => String.fromCharCode(97 + index % 26),
        ).join(""),
        sequence: 1,
      }),
    ]);
  });

  it("mounts the session log before the first activity", async () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "waiting",
      observations: [],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const log = wrapper.get('[role="log"]').element;

    expect(wrapper.get('[role="status"]').text()).toContain("Waiting for the first update");
    await wrapper.setProps({
      invocation: {
        ...invocation,
        observations: [{
          attributes: { "message.content": "Started", "message.id": "assistant", "message.role": "assistant" },
          name: "agent.message",
          sequence: 1,
          timestamp,
          type: "lifecycle" as const,
        }],
      },
    });

    expect(wrapper.get('[role="log"]').element).toBe(log);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.get('[role="log"] li').text()).toContain("Started");
  });

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

    const activities = invocationActivities(invocation);
    expect(activities.slice(0, -1).every(activity => activity.truncated === undefined)).toBe(true);
    expect(activities.at(-1)).toMatchObject({
      id: "trace-truncated",
      kind: "system",
      name: "vitehub.observation.truncated",
      sequence: 2,
      status: "completed",
    });
    expect(invocationActivities({
      ...invocation,
      observations: [],
      observationsTruncated: true,
    })).toEqual([
      expect.objectContaining({ id: "trace-truncated", kind: "system", sequence: 0 }),
    ]);
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

    const activities = invocationActivities(invocation);
    expect(activities).toHaveLength(2);
    expect(activities[0]).not.toHaveProperty("truncated");
    expect(activities[1]).toMatchObject({
      id: "trace-truncated",
      kind: "system",
      name: "vitehub.observation.truncated",
    });
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    expect(wrapper.text()).toContain("Trace content was truncated");
    const inspector = mount(AgentInvocationInspector, { props: { invocation } });
    const metrics = inspector.findAll(".vh-invocation-inspector__metrics > div");
    expect(metrics.find(metric => metric.get("dt").text() === "Steps")?.get("dd").text()).toBe("1");
    const timelineRows = inspector.findAll(".vh-invocation-timeline__row");
    expect(timelineRows).toHaveLength(1);
    expect(timelineRows[0]!.text()).not.toContain("Trace content was truncated");
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
      { filename: "retained.png", mediaType: "image/png", type: "file", url: "/files/retained-image" },
      { filename: "unsafe.png", mediaType: "image/png", type: "file", url: "javascript:alert(1)" },
      { mediaType: "text/html", type: "file", url: "data:text/html,<script>alert(1)</script>" },
    ];
    const wrapper = mount(AgentMessageParts, {
      global: { components: { UModal: defineComponent({ setup: (_, { slots }) => () => slots.default?.() }) } },
      props: { parts },
    });

    expect(wrapper.findAll("a").map(link => link.attributes("href"))).toEqual([
      "https://example.com/safe.txt",
    ]);
    expect(wrapper.findAll("img").map(image => image.attributes("src"))).toEqual(["data:image/png;base64,c2FmZQ==", "/files/retained-image"]);
    expect(wrapper.findAll("a")[0]!.attributes("rel")).toBe("noreferrer");
    expect(wrapper.get("img").attributes("alt")).toBe("inline.png");
    expect(wrapper.text()).toContain("unsafe.txt");
    expect(wrapper.get('[aria-label="Preview inline.png"]').attributes("type")).toBe("button");
    expect(wrapper.text()).toContain("unsafe.png");
    expect(wrapper.text()).toContain("text/html");
  });

  it("renders the working state with the loader-circle path", () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        items: [{ id: "running", status: "running", title: "Working session" }],
      },
    });

    expect(wrapper.get('[data-status="running"] .vh-invocation-list__state-icon path').attributes("d"))
      .toBe("M21 12a9 9 0 1 1-6.219-8.56");
  });

  it("groups sessions by lifecycle and sorts each group by recency", () => {
    const items = [
      { id: "done-old", status: "completed" as const, title: "Done old", updatedAt: "2026-08-20T00:00:00Z" },
      { id: "queued-old", status: "pending" as const, title: "Queued old", updatedAt: "2026-08-21T00:00:00Z" },
      { id: "working-old", status: "running" as const, title: "Working old", updatedAt: "2026-08-22T00:00:00Z" },
      { id: "done-new", status: "failed" as const, title: "Done new", updatedAt: "2026-08-24T00:00:00Z" },
      { id: "queued-new", status: "pending" as const, title: "Queued new", updatedAt: "2026-08-25T00:00:00Z" },
      { id: "working-new", status: "running" as const, title: "Working new", updatedAt: "2026-08-26T00:00:00Z" },
    ];
    const wrapper = mount(AgentInvocationList, { props: { items } });
    const groups = wrapper.findAll(".vh-invocation-list__group");

    expect(groups.map(group => group.attributes("data-group"))).toEqual(["working", "queued", "done"]);
    expect(groups.map(group => group.element.tagName)).toEqual(["SECTION", "DETAILS", "DETAILS"]);
    expect(wrapper.get('details[data-group="queued"]').attributes("open")).toBe("");
    expect(wrapper.get('details[data-group="done"]').attributes("open")).toBeUndefined();
    expect(groups.map(group => group.findAll(".vh-invocation-list__title").map(title => title.text()))).toEqual([
      ["Working new", "Working old"],
      ["Queued new", "Queued old"],
      ["Done new", "Done old"],
    ]);
  });

  it("marks lifecycle counts as partial while older matching sessions remain", () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        hasMore: true,
        items: [
          { id: "working", status: "running", title: "Working" },
          { id: "done", status: "completed", title: "Done" },
        ],
        remainingStatuses: ["completed"],
      },
    });

    const counts = wrapper.findAll(".vh-invocation-list__group-count");
    expect(counts.map(count => count.text())).toEqual(["1", "1+"]);
    expect(counts[1]!.attributes("aria-label")).toBe("At least 1 session; more available");
  });

  it("reveals the selected terminal session", () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        items: [{ id: "done", status: "completed", title: "Done" }],
        selectedId: "done",
      },
    });

    expect(wrapper.get('details[data-group="done"]').attributes("open")).toBe("");
  });

  it("reopens Done for each newly selected terminal session", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        items: [
          { id: "first", status: "completed", title: "First" },
          { id: "second", status: "completed", title: "Second" },
        ],
        selectedId: "first",
      },
    });
    const done = wrapper.get('details[data-group="done"]');
    if (!(done.element instanceof HTMLDetailsElement)) throw new TypeError("Expected a details element");
    done.element.open = false;
    await done.trigger("toggle");

    await wrapper.setProps({ selectedId: "second" });

    expect(wrapper.get('details[data-group="done"]').attributes("open")).toBe("");
  });

  it("reopens Queued for each newly selected pending session", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        items: [
          { id: "first", status: "pending", title: "First" },
          { id: "second", status: "pending", title: "Second" },
        ],
        selectedId: "first",
      },
    });
    const queued = wrapper.get('details[data-group="queued"]');
    if (!(queued.element instanceof HTMLDetailsElement)) throw new TypeError("Expected a details element");
    queued.element.open = false;
    await queued.trigger("toggle");

    await wrapper.setProps({ selectedId: "second" });

    expect(wrapper.get('details[data-group="queued"]').attributes("open")).toBe("");
  });

  it("opens Done when the selected terminal session arrives", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: { items: [], selectedId: "done" },
    });

    await wrapper.setProps({
      items: [{ id: "done", status: "completed", title: "Done" }],
    });

    expect(wrapper.get('details[data-group="done"]').attributes("open")).toBe("");
  });

  it("opens Done when the selected session becomes terminal", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        items: [{ id: "selected", status: "running", title: "Selected" }],
        selectedId: "selected",
      },
    });

    await wrapper.setProps({
      items: [{ id: "selected", status: "completed", title: "Selected" }],
    });

    expect(wrapper.get('details[data-group="done"]').attributes("open")).toBe("");
  });

  it.each([
    ["pending", "running"],
    ["running", "completed"],
  ] as const)("preserves focus when a session moves from %s to %s", async (before, after) => {
    const wrapper = mount(AgentInvocationList, {
      attachTo: document.body,
      props: {
        items: [{ id: "moving", status: before, title: "Moving" }],
        selectedId: "moving",
      },
    });
    wrapper.get<HTMLButtonElement>('[data-invocation-id="moving"]').element.focus();

    await wrapper.setProps({
      items: [{ id: "moving", status: after, title: "Moving" }],
    });
    await nextTick();

    expect(document.activeElement).toBe(wrapper.get('[data-invocation-id="moving"]').element);
    wrapper.unmount();
  });

  it("opens Done before restoring focus to an unselected terminal session", async () => {
    const wrapper = mount(AgentInvocationList, {
      attachTo: document.body,
      props: {
        items: [{ id: "moving", status: "running", title: "Moving" }],
      },
    });
    wrapper.get<HTMLButtonElement>('[data-invocation-id="moving"]').element.focus();

    await wrapper.setProps({
      items: [{ id: "moving", status: "completed", title: "Moving" }],
    });
    await nextTick();

    expect(wrapper.get('details[data-group="done"]').attributes("open")).toBe("");
    expect(document.activeElement).toBe(wrapper.get('[data-invocation-id="moving"]').element);
    wrapper.unmount();
  });

  it("keeps every session in the accessible navigation list", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      description: index === 0 ? "The host stopped before this invocation finished." : undefined,
      id: `inv-${index}`,
      status: "completed" as const,
      title: `Invocation ${index}`,
    }));
    const wrapper = mount(AgentInvocationList, {
      props: { items },
    });

    expect(wrapper.findAll("li")).toHaveLength(100);
    expect(wrapper.text()).toContain("The host stopped before this invocation finished.");
  });

  it("renders configuration and delivery lifecycle events", async () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "lifecycle",
      observations: [
        {
          attributes: {
            "vitehub.activity.body": "Agent configuration is available for inspection.",
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
    const system = wrapper.get('[data-kind="system"]');
    expect(system.get("summary").element.tagName).toBe("SUMMARY");
    await system.get("summary").trigger("click");
    expect(wrapper.emitted("inspect")).toBeUndefined();
    await system.get(".vh-invocation-event__inspect").trigger("click");
    const delivery = wrapper.get('[data-kind="delivery"] .vh-invocation-event__summary');
    expect(delivery.element.tagName).toBe("BUTTON");
    await delivery.trigger("click");
    expect(wrapper.emitted("inspect")).toEqual([["agent"], ["workspace"]]);
  });

  it("keeps a failed delivery's error inspectable beside its captured reply", async () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "failed-delivery",
      observations: [{
        attributes: {
          "channel.effect.content": "Partially delivered reply.",
          "channel.effect.kind": "reply",
          "error.message": "Telegram disconnected",
        },
        name: "agent.channel.delivery",
        sequence: 1,
        timestamp,
        type: "error" as const,
      }],
      status: "failed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const delivery = wrapper.get('[data-kind="delivery"]');

    expect(invocationActivityTitle(invocationActivities(invocation)[0]!)).toBe("Reply failed");
    expect(invocationActivities(invocation)[0]?.status).toBe("failed");
    expect(delivery.get("summary").element.tagName).toBe("SUMMARY");
    expect(delivery.get(".vh-invocation-delivery__body").text()).toBe("Partially delivered reply.");
    expect(delivery.get(".vh-invocation-delivery__body").element.parentElement).toBe(delivery.element);
    await delivery.get("summary").trigger("click");
    expect(delivery.get(".vh-invocation-event__failure").text()).toBe("Telegram disconnected");
    expect(delivery.findAll(".vh-invocation-event__markdown")).toHaveLength(1);
  });

  it("does not present a failed non-reply delivery error as sent content", async () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "failed-reaction",
      observations: [{
        attributes: {
          "channel.effect.kind": "reaction",
          "error.message": "Reaction delivery failed",
        },
        name: "agent.channel.delivery",
        sequence: 1,
        timestamp,
        type: "error" as const,
      }],
      status: "failed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const delivery = mount(AgentInvocation, { props: { invocation } }).get('[data-kind="delivery"]');

    expect(invocationActivityTitle(invocationActivities(invocation)[0]!)).toBe("Reaction failed");
    expect(invocationActivities(invocation)[0]?.status).toBe("failed");
    expect(delivery.find(".vh-invocation-delivery__body").exists()).toBe(false);
    await delivery.get("summary").trigger("click");
    expect(delivery.get(".vh-invocation-event__failure").text()).toBe("Reaction delivery failed");
    expect(delivery.find(".vh-invocation-event__body").exists()).toBe(false);
  });

  it("discloses truncation beside a visible delivery body", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "truncated-delivery",
      observations: [{
        attributes: {
          "channel.effect.content": "Bounded reply.",
          "channel.effect.kind": "reply",
          "vitehub.observation.truncated": true,
        },
        name: "agent.channel.delivery",
        sequence: 1,
        timestamp,
        type: "run" as const,
      }],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const delivery = wrapper.get('[data-kind="delivery"]');

    expect(delivery.find("summary").exists()).toBe(false);
    expect(delivery.get(".vh-invocation-delivery__body").text()).toBe("Bounded reply.");
    expect(wrapper.get('[data-activity-id="trace-truncated"] .vh-invocation-event__title').text()).toBe("Trace content was truncated");
  });

  it("preserves Markdown-significant whitespace in captured delivery bodies", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "indented-delivery",
      observations: [{
        attributes: {
          "channel.effect.content": "    delivered as code\n",
          "channel.effect.kind": "reply",
        },
        name: "agent.channel.delivery",
        sequence: 1,
        timestamp,
        type: "run" as const,
      }],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const delivery = mount(AgentInvocation, { props: { invocation } }).get('[data-kind="delivery"]');

    expect(delivery.get(".vh-invocation-delivery__body .vh-invocation-event__markdown").element.textContent)
      .toBe("    delivered as code\n");
  });

  it("includes failure in a collapsed activity's accessible text", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "failed-tool",
      observations: [{
        attributes: { "tool.name": "Search" },
        name: "agent.tool.error",
        sequence: 1,
        timestamp,
        type: "error" as const,
      }],
      status: "failed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });

    expect(wrapper.get('[data-status="failed"] .vh-visually-hidden').text()).toBe("Failed");
  });

  it("renders progress summary replacements as bordered ViteHub actions", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "progress-summary",
      observations: [{
        attributes: {
          "step.id": "progress-summary:2",
          "tool.id": "progress-summary:2",
          "tool.name": "vitehub_progress_summary",
          "tool.output": "Checking Airtable for assigned tasks.",
          "vitehub.action.name": "progress-summary.update",
          "vitehub.activity.body": "Checking Airtable for assigned tasks.",
          "vitehub.activity.kind": "action",
          "vitehub.activity.progress": "Checking Airtable for assigned tasks.",
          "content.omitted": ["tool.output", "vitehub.activity.body", "vitehub.activity.title"],
        },
        name: "agent.tool.finish",
        sequence: 1,
        timestamp,
        type: "run" as const,
      }],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    const activities = invocationActivities(invocation);
    expect(activities).toEqual([
      expect.objectContaining({
        body: "Checking Airtable for assigned tasks.",
        kind: "action",
        status: "completed",
      }),
    ]);

    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const action = wrapper.get('.vh-invocation-activity[data-kind="action"]');
    expect(action.get(".vh-invocation-event__title").text()).toBe("Updated loading message");
    expect(action.get(".vh-invocation-event__body").text()).toBe("Checking Airtable for assigned tasks.");
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

  it("groups terminal work while keeping external effects and the final answer visible", async () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      cancelledAt: "2026-08-22T00:00:05.000Z",
      createdAt: timestamp,
      id: "completed-thread",
      observations: [
        { attributes: { "message.content": "Run it.", "message.id": "user", "message.role": "user" }, name: "agent.message", sequence: 1, timestamp, type: "lifecycle" as const },
        { attributes: { "channel.effect.intent": "started", "channel.effect.kind": "reaction" }, name: "agent.channel.delivery", sequence: 2, timestamp, type: "run" as const },
        { attributes: { "tool.id": "shell", "tool.input": { command: "pnpm test" }, "tool.name": "shell" }, name: "agent.tool.start", sequence: 3, timestamp, type: "run" as const },
        { attributes: { "tool.id": "shell", "tool.output": "passed", "tool.name": "shell" }, name: "agent.tool.finish", sequence: 4, timestamp, type: "run" as const },
        {
          attributes: {
            "channel.delivery.provider": "telegram",
            "channel.effect.content": "The Telegram reply body.",
            "channel.effect.kind": "reply",
          },
          name: "agent.channel.delivery",
          sequence: 5,
          timestamp,
          type: "run" as const,
        },
        { attributes: { "message.content": "Done.", "message.id": "assistant", "message.role": "assistant" }, name: "agent.message", sequence: 6, timestamp, type: "lifecycle" as const },
        { attributes: { "tool.id": "verify", "tool.output": "clean", "tool.name": "verify" }, name: "agent.tool.finish", sequence: 7, timestamp, type: "run" as const },
      ],
      startedAt: timestamp,
      status: "cancelled" as const,
      traceId: "trace",
      updatedAt: "2026-08-22T00:00:09.000Z",
    } satisfies AgentInvocationView;

    const wrapper = mount(AgentInvocation, { props: { invocation } });
    expect(wrapper.get('[role="log"]').attributes("aria-relevant")).toBe("additions text");
    expect(wrapper.get('[role="log"] > ol').attributes("role")).toBeUndefined();
    expect(wrapper.get('[role="log"] > ol').attributes("aria-label")).toBeUndefined();
    const rows = wrapper.findAll(".vh-invocation-activities > li");
    expect(rows.map(row => row.classes().find(name => name.startsWith("vh-invocation-") && name !== "vh-invocation-activities"))).toEqual([
      "vh-invocation-message",
      "vh-invocation-activity",
      "vh-invocation-activity",
      "vh-invocation-work",
      "vh-invocation-message",
    ]);
    expect(rows[1]!.attributes("data-kind")).toBe("delivery");
    expect(rows[2]!.attributes("data-kind")).toBe("delivery");
    expect(wrapper.findAll(".vh-invocation-work")).toHaveLength(1);
    expect(wrapper.find(".vh-invocation-work__activities").exists()).toBe(false);
    const work = wrapper.get(".vh-invocation-work__details");
    if (!(work.element instanceof HTMLDetailsElement)) throw new TypeError("Expected work details");
    work.element.open = true;
    await work.trigger("toggle");
    expect(wrapper.get(".vh-invocation-work__activities").text()).toContain("Shell");
    expect(wrapper.get(".vh-invocation-work__activities").text()).toContain("Verify");
    expect(rows[4]!.text()).toContain("Done.");
    expect(rows[2]!.get('[data-icon="message"]').attributes("data-icon")).toBe("message");
    expect(rows[2]!.get(".vh-invocation-delivery__body").text()).toBe("The Telegram reply body.");
  });

  it("keeps adjacent completed lifecycle activities grouped", async () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "completed-groups",
      observations: [
        { attributes: { "message.content": "Run it.", "message.id": "user", "message.role": "user" }, name: "agent.message", sequence: 1, timestamp, type: "lifecycle" as const },
        { attributes: { "vitehub.activity.group": "github-completion" }, name: "github.first", sequence: 2, timestamp, type: "run" as const },
        { attributes: { "vitehub.activity.group": "github-completion" }, name: "github.second", sequence: 3, timestamp, type: "run" as const },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const work = wrapper.get(".vh-invocation-work__details");
    if (!(work.element instanceof HTMLDetailsElement)) throw new TypeError("Expected work details");
    work.element.open = true;
    await work.trigger("toggle");

    expect(wrapper.findAll(".vh-invocation-lifecycle")).toHaveLength(1);
    expect(wrapper.findAll(".vh-invocation-lifecycle li")).toHaveLength(2);
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
            { id: "tool", parts: [{ text: "The check passed.", type: "text" }], role: "tool" },
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
      ["tool", "The check passed."],
    ]);
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    expect(wrapper.get('[data-role="system"] .vh-visually-hidden').text()).toBe("System message");
    expect(wrapper.get('[data-role="user"] .vh-visually-hidden').text()).toBe("User message");
    expect(wrapper.get('[data-role="assistant"] .vh-visually-hidden').text()).toBe("Assistant message");
    expect(wrapper.get('[data-role="tool"] .vh-visually-hidden').text()).toBe("Tool message");
  });

  it("keeps completed multi-turn conversations outside work summaries", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      completedAt: timestamp,
      createdAt: timestamp,
      id: "multi-turn-invocation",
      observations: [{
        attributes: {
          "input.messages": [
            { id: "user-1", parts: [{ text: "First question", type: "text" }], role: "user" },
            { id: "assistant-1", parts: [{ text: "First answer", type: "text" }], role: "assistant" },
            { id: "user-2", parts: [{ text: "Follow-up question", type: "text" }], role: "user" },
            { id: "assistant-2", parts: [{ text: "Final answer", type: "text" }], role: "assistant" },
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
    expect(wrapper.findAll(".vh-invocation-work")).toHaveLength(0);
    expect(wrapper.findAll(".vh-invocation-message").map(message => message.text())).toEqual([
      expect.stringContaining("First question"),
      expect.stringContaining("First answer"),
      expect.stringContaining("Follow-up question"),
      expect.stringContaining("Final answer"),
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

  it("explores structured tool payloads and selects a timed trace activity", async () => {
    const invocation = {
      completedAt: "2026-08-22T00:00:03.000Z",
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "trace-context",
      observations: [
        {
          attributes: {
            "step.id": "materialize",
            "tool.id": "materialize",
            "tool.input": { path: "workspace root" },
            "tool.name": "materialize_sources",
            "vitehub.activity.kind": "preparation",
            "vitehub.activity.title": "Materialized ViteHub workspace",
          },
          name: "agent.tool.start",
          sequence: 1,
          timestamp: "2026-08-22T00:00:00.250Z",
          type: "run" as const,
        },
        {
          attributes: {
            "step.id": "materialize",
            "tool.durationMs": 500,
            "tool.id": "materialize",
            "tool.name": "materialize_sources",
            "tool.output": { files: 12, summary: "Materialized repository (12 files)." },
          },
          name: "agent.tool.finish",
          sequence: 2,
          timestamp: "2026-08-22T00:00:00.750Z",
          type: "run" as const,
        },
        {
          attributes: {
            "tool.id": "query",
            "tool.input": { summary: "Private query omitted." },
            "tool.name": "database_query",
          },
          name: "agent.tool.start",
          sequence: 3,
          timestamp: "2026-08-22T00:00:01.000Z",
          type: "run" as const,
        },
        {
          attributes: {
            "tool.id": "query",
            "tool.error": "Result was incomplete.",
            "tool.name": "database_query",
            "tool.output": "  Returned 1 row.\n",
          },
          name: "agent.tool.finish",
          sequence: 4,
          timestamp: "2026-08-22T00:00:02.000Z",
          type: "run" as const,
        },
      ],
      startedAt: "2026-08-22T00:00:00.000Z",
      status: "completed" as const,
      traceId: "trace",
      updatedAt: "2026-08-22T00:00:03.000Z",
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)).toEqual([
      expect.objectContaining({
        durationMs: 500,
        endedAt: "2026-08-22T00:00:00.750Z",
        preview: "Materialized repository (12 files).",
        startedAt: "2026-08-22T00:00:00.250Z",
      }),
      expect.objectContaining({ durationMs: 1_000, startedAt: "2026-08-22T00:00:01.000Z" }),
    ]);

    const thread = mount(AgentInvocation, { props: { invocation } });
    expect(thread.findAll(".vh-invocation-event__payload > summary > strong").map(item => item.text())).toEqual([
      "Input",
      "Output",
      "Error",
    ]);
    expect(thread.text()).toContain("Private query omitted.");
    expect(thread.text()).toContain("Returned 1 row.");
    expect(thread.text()).toContain("Result was incomplete.");
    const payloads = thread.findAll(".vh-invocation-event__payload");
    expect(payloads[0]!.get("summary code").text()).toContain("Private query omitted.");
    expect(payloads[0]!.find(".vh-invocation-payload__content").exists()).toBe(false);
    if (!(payloads[0]!.element instanceof HTMLDetailsElement)) throw new TypeError("Expected a details element");
    payloads[0]!.element.open = true;
    await payloads[0]!.trigger("toggle");
    expect(payloads[0]!.findAll(".vh-invocation-payload__key").map(item => item.text())).toContain("summary");
    await payloads[0]!.get('button[aria-pressed="false"]').trigger("click");
    expect(payloads[0]!.get("pre").text()).toContain('"summary": "Private query omitted."');
    await payloads[0]!.get('input[type="search"]').setValue("missing");
    await payloads[0]!.get('button[aria-pressed="false"]').trigger("click");
    expect(payloads[0]!.text()).toContain("No matching fields");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await payloads[0]!.get(".vh-invocation-payload__copy").trigger("click");
    expect(writeText).toHaveBeenCalledWith('{\n  "summary": "Private query omitted."\n}');
    expect(payloads[0]!.get(".vh-invocation-payload__copy").text()).toBe("Copied");

    const inspector = mount(AgentInvocationInspector, { props: { invocation } });
    const rows = inspector.findAll(".vh-invocation-timeline__row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.attributes()).toMatchObject({
      "data-owner": "vitehub",
      title: "Materialized ViteHub workspace — Materialized repository (12 files).",
    });
    expect(rows[0]!.text()).toContain("+250ms · 500ms");
    expect(rows[1]!.attributes("data-owner")).toBe("agent");
    expect(rows[1]!.text()).toContain("+1s · 1s");
    await rows[1]!.trigger("click");
    expect(inspector.emitted("selectActivity")).toEqual([[rows[1]!.attributes("data-activity-id")]]);

    const selected = mount(AgentInvocation, {
      props: { invocation, selectedActivityId: rows[0]!.attributes("data-activity-id") },
    });
    await nextTick();
    const selectedEvent = selected.get(`[data-activity-id="${rows[0]!.attributes("data-activity-id")}"]`);
    expect(selectedEvent.attributes("data-selected")).toBe("true");
    const selectedDetails = selectedEvent.element.closest("details");
    if (!(selectedDetails instanceof HTMLDetailsElement)) throw new TypeError("Expected a details element");
    expect(selectedDetails.open).toBe(true);
    await selected.setProps({ selectedActivityId: undefined });
    await selected.setProps({ selectedActivityId: rows[0]!.attributes("data-activity-id") });
    await nextTick();
    expect(selected.get(`[data-activity-id="${rows[0]!.attributes("data-activity-id")}"]`).attributes("data-selected")).toBe("true");

    const regroupedInvocation = {
      ...invocation,
      observations: [
        { attributes: { "message.content": "Inspect the repository", "message.id": "user", "message.role": "user" }, name: "agent.message", sequence: 0, timestamp: invocation.startedAt, type: "lifecycle" as const },
        ...invocation.observations,
      ],
    } satisfies AgentInvocationView;
    const regroupedActivityId = invocationActivities(regroupedInvocation).find(activity => activity.kind === "tool")!.id;
    const regrouped = mount(AgentInvocation, {
      props: { invocation: { ...regroupedInvocation, status: "running" }, selectedActivityId: regroupedActivityId },
    });
    await nextTick();
    const focusedEvent = regrouped.get(`[data-activity-id="${regroupedActivityId}"]`).element;
    if (!(focusedEvent instanceof HTMLElement)) throw new TypeError("Expected an HTML element");
    const focus = vi.spyOn(focusedEvent, "focus");
    await regrouped.setProps({ invocation: { ...regroupedInvocation, status: "running" } });
    await nextTick();
    expect(focus).not.toHaveBeenCalled();
    await regrouped.setProps({ invocation: regroupedInvocation });
    await nextTick();
    const regroupedEvent = regrouped.get(`[data-activity-id="${regroupedActivityId}"]`);
    expect(regroupedEvent.attributes("data-selected")).toBe("true");
    expect(regroupedEvent.element.closest(".vh-invocation-work__details")).toHaveProperty("open", true);
  });

  it("bounds large payload trees and safely serializes repeated and circular values", async () => {
    const shared = { value: "shared" };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const input = {
      big: 12n,
      circular,
      fields: Object.fromEntries(Array.from({ length: 800 }, (_, index) => [`field${index}`, index])),
      siblings: Object.fromEntries(Array.from({ length: 800 }, (_, index) => [`sibling${index}`, index])),
      first: shared,
      second: shared,
    };
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "large-payload",
      observations: [
        { attributes: { "tool.id": "inspect", "tool.input": input, "tool.name": "inspect" }, name: "agent.tool.start", sequence: 1, timestamp, type: "run" as const },
        { attributes: { "tool.id": "inspect", "tool.name": "inspect", "tool.output": { ok: true } }, name: "agent.tool.finish", sequence: 2, timestamp, type: "run" as const },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const payload = wrapper.findAll(".vh-invocation-event__payload")[0]!;

    expect(payload.find(".vh-invocation-payload__tree").exists()).toBe(false);
    if (!(payload.element instanceof HTMLDetailsElement)) throw new TypeError("Expected a details element");
    payload.element.open = true;
    await payload.trigger("toggle");
    expect(payload.findAll("li")).toHaveLength(500);
    expect(payload.text()).toContain("More fields hidden");

    await payload.get('button[aria-pressed="false"]').trigger("click");
    const raw = payload.get("pre").text();
    expect(raw.match(/"value": "shared"/g)).toHaveLength(2);
    expect(raw).toContain('"self": "[Circular]"');
    expect(raw).toContain('"big": "12n"');

    const deep = Array.from({ length: 11 }).reduce<Record<string, unknown>>(
      value => ({ nested: value }),
      { needle: "visible boundary" },
    );
    const deepWrapper = mount(AgentInvocation, { props: { invocation: {
      ...invocation,
      observations: [{ attributes: { "tool.id": "inspect", "tool.input": deep, "tool.name": "inspect" }, name: "agent.tool.start", sequence: 1, timestamp, type: "run" as const }],
      status: "running" as const,
    } } });
    const deepPayload = deepWrapper.get(".vh-invocation-event__payload");
    if (!(deepPayload.element instanceof HTMLDetailsElement)) throw new TypeError("Expected a details element");
    deepPayload.element.open = true;
    await deepPayload.trigger("toggle");
    await deepPayload.get('input[type="search"]').setValue("visible boundary");
    expect(deepPayload.text()).toContain("$.nested");

    const searchWrapper = mount(AgentInvocation, { props: { invocation: {
      ...invocation,
      observations: [{ attributes: {
        "tool.id": "inspect",
        "tool.input": { empty: {}, matches: Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`match${index}`, "needle"])) },
        "tool.name": "inspect",
      }, name: "agent.tool.start", sequence: 1, timestamp, type: "run" as const }],
      status: "running" as const,
    } } });
    const searchPayload = searchWrapper.get(".vh-invocation-event__payload");
    if (!(searchPayload.element instanceof HTMLDetailsElement)) throw new TypeError("Expected a details element");
    searchPayload.element.open = true;
    await searchPayload.trigger("toggle");
    await searchPayload.get('input[type="search"]').setValue("empty");
    expect(searchPayload.text()).toContain("$.empty");
    await searchPayload.get('input[type="search"]').setValue("needle");
    expect(searchPayload.findAll(".vh-invocation-payload__matches li")).toHaveLength(501);
    expect(searchPayload.text()).toContain("More matches hidden. Refine your search.");
  });

  it("renders unsafe payloads before a tool reaches a terminal state", () => {
    const input = { toJSON() { throw new Error("serialization failed"); } };
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "throwing-payload",
      observations: [
        { attributes: { "tool.id": "inspect", "tool.input": input, "tool.name": "inspect" }, name: "agent.tool.start", sequence: 1, timestamp, type: "run" as const },
      ],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(mount(AgentInvocation, { props: { invocation } }).text()).toContain("Unable to display payload: serialization failed");
  });

  it("keeps rounded and terminal trace timings inside their bounds", () => {
    const invocation = {
      completedAt: "2026-08-22T00:01:59.999Z",
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "trace-boundaries",
      observations: [{
        attributes: { "tool.durationMs": 1_000, "tool.id": "terminal", "tool.name": "finish" },
        name: "agent.tool.finish",
        sequence: 1,
        timestamp: "2026-08-22T00:01:59.999Z",
        type: "run" as const,
      }],
      startedAt: "2026-08-22T00:00:00.000Z",
      status: "completed" as const,
      traceId: "trace",
      updatedAt: "2026-08-22T00:01:59.999Z",
    } satisfies AgentInvocationView;

    const row = mount(AgentInvocationInspector, { props: { invocation } })
      .get(".vh-invocation-timeline__row");
    expect(row.text()).toContain("+1m 59s · 1s");
    expect(row.get(".vh-invocation-timeline__track span").attributes("style"))
      .toContain("left: 98.5%");
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
      const terminalTimestamp = "2026-08-22T00:00:01.000Z";
      const invocation = {
        completedAt: "2026-08-22T00:00:03.000Z",
        createdAt: timestamp,
        id: "provider-command",
        observations: [
          { attributes: { "tool.id": "command", "tool.input": { command: "pnpm test" }, "tool.name": "shell" }, name: "agent.tool.start", sequence: 1, timestamp, type: "run" as const },
          { attributes: { "tool.id": "command", "tool.output": "first\n", "tool.name": "shell" }, name: "agent.tool.output", sequence: 2, timestamp, type: "run" as const },
          { attributes: { "tool.id": "command", "tool.output": "second\n", "tool.name": "shell" }, name: "agent.tool.output", sequence: 3, timestamp, type: "run" as const },
          { attributes: { "tool.id": "command", "tool.output": { summary: "Still running" }, "tool.name": "shell" }, name: "agent.tool.progress", sequence: 4, timestamp, type: "run" as const },
          { attributes: { "tool.id": "command", "tool.output": { detail: "terminal state" }, "tool.name": "shell" }, name: terminalName, sequence: 5, timestamp: terminalTimestamp, type: terminalName.endsWith(".error") ? "error" as const : "run" as const },
        ],
        status: "completed" as const,
        traceId: "trace",
        updatedAt: timestamp,
      } satisfies AgentInvocationView;

      expect(invocationActivities(invocation)[0]).toMatchObject({
        command: { output: "first\nsecond\n" },
        durationMs: 1_000,
        endedAt: terminalTimestamp,
      });
    },
  );

  it("bounds failed tasks by their observed failure", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const failedAt = "2026-08-22T00:00:01.000Z";
    const invocation = {
      completedAt: "2026-08-22T00:00:03.000Z",
      createdAt: timestamp,
      id: "failed-task",
      observations: [
        { attributes: { "step.id": "task" }, name: "agent.task.started", sequence: 1, timestamp, type: "run" as const },
        { attributes: { "error.message": "Task failed", "step.id": "task" }, name: "agent.task.failed", sequence: 2, timestamp: failedAt, type: "run" as const },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)[0]).toMatchObject({
      durationMs: 1_000,
      endedAt: failedAt,
      status: "failed",
    });
  });

  it("extends running activities through the invocation update", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const updatedAt = "2026-08-22T00:00:03.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "running-tool",
      observations: [
        { attributes: { "tool.id": "command", "tool.name": "shell" }, name: "agent.tool.start", sequence: 1, timestamp, type: "run" as const },
        { attributes: { "tool.id": "command", "tool.name": "shell" }, name: "agent.tool.progress", sequence: 2, timestamp: "2026-08-22T00:00:01.000Z", type: "run" as const },
      ],
      status: "running" as const,
      traceId: "trace",
      updatedAt,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)[0]).toMatchObject({
      durationMs: 3_000,
      endedAt: updatedAt,
      status: "running",
    });
  });

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
        { attributes: { "tool.id": "tool", "tool.input": { query: "agent UI" }, "tool.name": "search", "tool.title": "airtable · search" }, name: "agent.tool.start", sequence: 1, timestamp, type: "lifecycle" as const },
        { attributes: { "tool.id": "tool", "tool.name": "search" }, name: "agent.tool.start", sequence: 2, timestamp, type: "lifecycle" as const },
        { attributes: { "tool.durationMs": 42, "tool.error": "Search unavailable", "tool.id": "tool" }, name: "agent.tool.error", sequence: 3, timestamp, type: "error" as const },
        { attributes: { "error.message": "Recoverable stream error", "error.recoverable": true }, name: "agent.stream.error", sequence: 4, timestamp, type: "error" as const },
        { attributes: { "approval.id": "approval", "approval.name": "Run command" }, name: "agent.approval.request", sequence: 5, timestamp, type: "approval" as const },
        { attributes: { "approval.approved": false, "approval.id": "approval", "approval.reason": "Command is destructive" }, name: "agent.approval.decision", sequence: 6, timestamp, type: "approval" as const },
      ],
      status: "completed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    const activities = invocationActivities(invocation);
    expect(activities.map(activity => [invocationActivityTitle(activity), activity.body, activity.status])).toEqual([
      ["Airtable · search", "Search unavailable", "failed"],
      ["Approval denied", "Command is destructive", "failed"],
    ]);
  });

  it("renders failed command diagnostics with command details", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "failed-command",
      observations: [
        { attributes: { "tool.id": "command", "tool.input": { command: "pnpm test" }, "tool.name": "shell" }, name: "agent.tool.start", sequence: 1, timestamp, type: "run" as const },
        { attributes: { "tool.error": "Command timed out", "tool.id": "command", "tool.name": "shell" }, name: "agent.tool.error", sequence: 2, timestamp, type: "error" as const },
      ],
      status: "failed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });

    expect(wrapper.get(".vh-invocation-command__bar code").text()).toBe("pnpm test");
    expect(wrapper.get('.vh-invocation-event__icon[data-icon="command"]')).toBeTruthy();
    expect(wrapper.get(".vh-invocation-event__failure-icon")).toBeTruthy();
    expect(wrapper.get(".vh-invocation-command .vh-invocation-event__payload > strong").text()).toBe("Error");
    expect(wrapper.get(".vh-invocation-command .vh-invocation-event__payload pre").text()).toBe("Command timed out");
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

  it("hydrates complete invocation lists without dropping rows", async () => {
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
    const copy = wrapper.get('button[aria-label="Copy Trace ID"]');
    await copy.trigger("click");
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(invocation.traceId);
    expect(copy.attributes("aria-label")).toBe("Trace ID copied");
    expect(copy.text()).toContain("Copied");
    expect(copy.find(".vh-invocation-inspector__copy-state").attributes("aria-live")).toBeUndefined();
    expect(wrapper.get('[role="status"]').text()).toBe("Trace ID copied");
    wrapper.unmount();
  });

  it("announces clipboard failures without an unhandled rejection", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("Clipboard denied"); }) },
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

    expect(wrapper.get('[role="status"]').text()).toBe("Trace ID could not be copied");
    expect(wrapper.get('button[aria-label="Copy Trace ID"]').text()).toContain("Copy");

    const status = wrapper.get('[role="status"]');
    await wrapper.get('button[aria-label="Copy Trace ID"]').trigger("click");
    expect(status.text()).toBe("");
    await Promise.resolve();
    expect(status.text()).toBe("Trace ID could not be copied");
  });

  it("announces when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
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

    expect(wrapper.get('[role="status"]').text()).toBe("Trace ID could not be copied");
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

    expect(wrapper.get(".vh-invocation-inspector__status").text()).toContain("Failed");
    expect(wrapper.get(".vh-invocation-error").text()).toBe(
      "Provider errorThe provider stopped before returning a result.",
    );
    const secondary = mount(AgentInvocationInspector, { props: { invocation, showError: false } });
    expect(secondary.text()).toContain("Failed");
    expect(secondary.find(".vh-invocation-error").exists()).toBe(false);

  });

  it("renders provider-owned recovery instructions without guessing advice", () => {
    const invocation: AgentInvocationView = {
      createdAt: "2026-08-22T00:00:00.000Z", id: "quota", observations: [],
      status: "failed", traceId: "trace", updatedAt: "2026-08-22T00:00:00.000Z",
      error: { code: "AGENT_R0726", message: "Workspace spend cap reached" },
    };
    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });
    expect(wrapper.find(".vh-invocation-error__recovery").exists()).toBe(false);
    expect(wrapper.get(".vh-invocation-error__details").text()).toContain("Workspace spend cap reached");
    const explicit = mount(AgentInvocationInspector, { props: { invocation: { ...invocation, error: { ...invocation.error!, fix: "Contact the workspace owner." } } } });
    expect(explicit.get(".vh-invocation-error__recovery").text()).toContain("Contact the workspace owner.");
  });

  it("keeps bounded runtime diagnostics available behind a disclosure", () => {
    const invocation: AgentInvocationView = {
      createdAt: "2026-08-22T00:00:00.000Z",
      error: {
        cause: { message: "The upstream socket closed.", name: "SocketError" },
        code: "provider_unavailable",
        message: "The provider stopped before returning a result.",
        name: "Provider error",
        requestId: "request-123",
        statusCode: 503,
      },
      failedAt: "2026-08-22T00:00:05.000Z",
      id: "failed-with-diagnostics",
      observations: [],
      startedAt: "2026-08-22T00:00:00.000Z",
      status: "failed",
      traceId: "trace",
      updatedAt: "2026-08-22T00:00:05.000Z",
    };
    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });

    expect(wrapper.get(".vh-invocation-error__details summary").text()).toBe("Diagnostic details");
    expect(wrapper.get(".vh-invocation-error__details pre").text()).toContain('"code": "provider_unavailable"');
    expect(wrapper.get(".vh-invocation-error__details pre").text()).toContain('"requestId": "request-123"');
    expect(wrapper.get(".vh-invocation-error__details pre").text()).toContain("The upstream socket closed.");
  });

  it("uses the cancellation timestamp for terminal duration", () => {
    const invocation: AgentInvocationView = {
      cancelledAt: "2026-08-22T00:01:05.000Z",
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "cancelled",
      observations: [{
        attributes: { "tool.id": "search", "tool.name": "search" },
        name: "agent.tool.start",
        sequence: 1,
        timestamp: "2026-08-22T00:01:00.000Z",
        type: "run",
      }],
      startedAt: "2026-08-22T00:00:00.000Z",
      status: "cancelled",
      traceId: "trace",
      updatedAt: "2026-08-22T00:01:05.000Z",
    };

    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });
    expect(wrapper.get(".vh-invocation-inspector__status small").text()).toBe("1m 5s");
    expect(invocationActivities(invocation)[0]).toMatchObject({
      durationMs: 5_000,
      endedAt: "2026-08-22T00:01:05.000Z",
      startedAt: "2026-08-22T00:01:00.000Z",
      status: "completed",
    });
    expect(wrapper.get(".vh-invocation-timeline__row").text()).toContain("+1m 0s · 5s");
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
    Object.defineProperties(viewport.element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollTop: { configurable: true, writable: true, value: 1_500 },
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

  it("continues automatic pagination when the cursor advances without new sessions", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        hasMore: true,
        items: [{ id: "working", status: "running", title: "Working" }],
        remainingStatuses: ["running", "pending", "completed"],
        continuationKey: "page-2",
      },
    });
    const viewport = wrapper.get("nav");
    Object.defineProperties(viewport.element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0 },
    });

    await viewport.trigger("scroll");
    expect(wrapper.emitted("endReached")).toHaveLength(1);

    await wrapper.setProps({ loading: true });
    await wrapper.setProps({ continuationKey: "page-4", loading: false });
    expect(wrapper.emitted("endReached")).toHaveLength(2);

    await wrapper.setProps({ loading: true });
    await wrapper.setProps({ continuationKey: "page-6", loading: false });
    expect(wrapper.emitted("endReached")).toHaveLength(3);
  });

  it("does not continue cursor pagination into collapsed terminal history", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        continuationKey: "page-2",
        hasMore: true,
        items: [{ id: "done", status: "completed", title: "Done" }],
        remainingStatuses: ["completed"],
        retryKey: 0,
      },
    });
    const viewport = wrapper.get("nav");
    Object.defineProperties(viewport.element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0 },
    });

    await wrapper.setProps({ continuationKey: "page-3" });
    expect(wrapper.emitted("endReached")).toBeUndefined();

    await wrapper.setProps({ retryKey: 1 });
    expect(wrapper.emitted("endReached")).toHaveLength(1);
  });

  it("does not scroll into collapsed terminal history", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        hasMore: true,
        items: [
          { id: "working", status: "running", title: "Working" },
          { id: "done", status: "completed", title: "Done" },
        ],
        remainingStatuses: ["completed"],
      },
    });
    const viewport = wrapper.get("nav");
    Object.defineProperties(viewport.element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollTop: { configurable: true, writable: true, value: 1_600 },
    });

    await viewport.trigger("scroll");

    expect(wrapper.emitted("endReached")).toBeUndefined();
  });

  it("requests another page when the loaded sessions do not fill the viewport", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        hasMore: false,
        items: [{ id: "one", status: "running", title: "One" }],
      },
    });
    const viewport = wrapper.get("nav").element;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0 },
    });

    await wrapper.setProps({ hasMore: true });

    expect(wrapper.emitted("endReached")).toHaveLength(1);
  });

  it("does not drain more pages while terminal sessions are collapsed", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        hasMore: false,
        items: [{ id: "done", status: "completed", title: "Done" }],
      },
    });
    const viewport = wrapper.get("nav").element;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 80 },
      scrollTop: { configurable: true, value: 0 },
    });

    await wrapper.setProps({ hasMore: true });
    await wrapper.setProps({
      items: [
        { id: "done", status: "completed", title: "Done" },
        { id: "older", status: "completed", title: "Older" },
      ],
    });

    expect(wrapper.emitted("endReached")).toBeUndefined();
  });

  it("continues through one hidden-only page without draining collapsed terminal pages", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        hasMore: false,
        items: [
          { id: "working", status: "running", title: "Working" },
          { id: "done", status: "completed", title: "Done" },
        ],
      },
    });
    const viewport = wrapper.get("nav").element;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0 },
    });

    await wrapper.setProps({ hasMore: true });
    expect(wrapper.emitted("endReached")).toHaveLength(1);

    await wrapper.setProps({
      items: [
        { id: "working", status: "running", title: "Working" },
        { id: "done", status: "completed", title: "Done" },
        { id: "older", status: "completed", title: "Older" },
      ],
    });
    expect(wrapper.emitted("endReached")).toHaveLength(2);

    await wrapper.setProps({
      items: [
        { id: "working", status: "running", title: "Working" },
        { id: "done", status: "completed", title: "Done" },
        { id: "older", status: "completed", title: "Older" },
        { id: "oldest", status: "completed", title: "Oldest" },
      ],
    });
    expect(wrapper.emitted("endReached")).toHaveLength(2);

    await wrapper.setProps({
      items: [
        { id: "working", status: "running", title: "Working" },
        { id: "queued", status: "pending", title: "Queued" },
        { id: "done", status: "completed", title: "Done" },
        { id: "older", status: "completed", title: "Older" },
        { id: "oldest", status: "completed", title: "Oldest" },
      ],
    });
    expect(wrapper.emitted("endReached")).toHaveLength(3);
  });

  it("continues across hidden pages while a visible lifecycle still has a cursor", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        hasMore: false,
        items: [
          { id: "working", status: "running", title: "Working" },
          { id: "done", status: "completed", title: "Done" },
        ],
        remainingStatuses: ["running", "completed"],
      },
    });
    const viewport = wrapper.get("nav").element;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0 },
    });

    await wrapper.setProps({ hasMore: true });
    expect(wrapper.emitted("endReached")).toHaveLength(1);
    await wrapper.setProps({
      items: [...wrapper.props("items"), { id: "older", status: "completed", title: "Older" }],
    });
    expect(wrapper.emitted("endReached")).toHaveLength(2);
    await wrapper.setProps({
      items: [...wrapper.props("items"), { id: "oldest", status: "completed", title: "Oldest" }],
    });
    expect(wrapper.emitted("endReached")).toHaveLength(3);

    await wrapper.setProps({ remainingStatuses: ["completed"] });
    await wrapper.setProps({
      items: [...wrapper.props("items"), { id: "done-last", status: "completed", title: "Done last" }],
    });
    expect(wrapper.emitted("endReached")).toHaveLength(3);
  });

  it("rechecks pagination when visible membership changes at the same count", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        hasMore: false,
        items: [{ id: "first", status: "running", title: "First" }],
      },
    });
    const viewport = wrapper.get("nav").element;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0 },
    });

    await wrapper.setProps({ hasMore: true });
    expect(wrapper.emitted("endReached")).toHaveLength(1);

    await wrapper.setProps({
      items: [
        { id: "first", status: "completed", title: "First" },
        { id: "second", status: "running", title: "Second" },
      ],
    });

    expect(wrapper.emitted("endReached")).toHaveLength(2);
  });

  it("rechecks pagination when visible sessions become terminal", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        hasMore: false,
        items: [
          { id: "working", status: "running", title: "Working" },
          { id: "transitioning", status: "running", title: "Transitioning" },
          { id: "done", status: "completed", title: "Done" },
        ],
      },
    });
    const viewport = wrapper.get("nav").element;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0 },
    });

    await wrapper.setProps({ hasMore: true });
    expect(wrapper.emitted("endReached")).toHaveLength(1);

    await wrapper.setProps({
      items: [
        { id: "working", status: "running", title: "Working" },
        { id: "transitioning", status: "completed", title: "Transitioning" },
        { id: "done", status: "completed", title: "Done" },
      ],
    });

    expect(wrapper.emitted("endReached")).toHaveLength(2);
  });

  it("checks pagination when a collapsed group is expanded", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        hasMore: true,
        items: [{ id: "done", status: "completed", title: "Done" }],
      },
    });
    const viewport = wrapper.get("nav").element;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0 },
    });
    const done = wrapper.get('details[data-group="done"]');

    if (!(done.element instanceof HTMLDetailsElement)) throw new TypeError("Expected a details element");
    done.element.open = true;
    await done.trigger("toggle");

    expect(wrapper.emitted("endReached")).toHaveLength(1);
  });

  it("does not paginate hidden terminal history when Queued is reopened", async () => {
    const wrapper = mount(AgentInvocationList, {
      props: {
        hasMore: true,
        items: [
          { id: "queued", status: "pending", title: "Queued" },
          { id: "done", status: "completed", title: "Done" },
        ],
        remainingStatuses: ["completed"],
      },
    });
    const viewport = wrapper.get("nav").element;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0 },
    });
    const queued = wrapper.get('details[data-group="queued"]');

    if (!(queued.element instanceof HTMLDetailsElement)) throw new TypeError("Expected a details element");
    queued.element.open = false;
    await queued.trigger("toggle");
    queued.element.open = true;
    await queued.trigger("toggle");

    expect(wrapper.emitted("endReached")).toBeUndefined();
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
      },
    });

    expect(wrapper.get("time").text()).toBe("Aug 23");
  });

  it("expands compact running times and uses their source timestamp", () => {
    const startedAt = "2026-08-23T09:15:00.000Z";
    const wrapper = mount(AgentInvocationList, {
      props: {
        items: [{ id: "running", startedAt, status: "running", title: "Running", updatedAt: "2026-08-23T09:19:00.000Z" }],
        now: Date.parse("2026-08-23T09:20:00.000Z"),
      },
    });

    expect(wrapper.get("time").attributes()).toMatchObject({
      "aria-label": "5 minutes ago",
      datetime: startedAt,
      title: "5 minutes ago",
    });
    expect(wrapper.get("time").text()).toBe("5m");
  });

  it("announces loading without replacing the session navigation", () => {
    const wrapper = mount(AgentInvocationList, {
      props: { items: [{ id: "one", status: "completed", title: "One" }], loading: true },
    });

    expect(wrapper.get("nav").attributes("aria-busy")).toBeUndefined();
    expect(wrapper.get(".vh-invocation-list__groups").attributes("aria-busy")).toBe("true");
    expect(wrapper.get('[role="status"]').text()).toBe("Loading sessions…");
    expect(wrapper.get('[role="status"]').element.closest('[aria-busy="true"]')).toBeNull();
    expect(wrapper.findAll("li")).toHaveLength(1);
  });

  it("keeps every row available when a header precedes the list", () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `inv-${index}`,
      status: "completed" as const,
      title: `Invocation ${index}`,
    }));
    const wrapper = mount(AgentInvocationList, {
      props: { items },
      slots: { header: "Header" },
    });
    expect(wrapper.text()).toContain("Header");
    expect(wrapper.findAll("li")).toHaveLength(40);
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
            "step.id": "vitehub.workspace.materialization:[\"docs\",\"\"]",
            "vitehub.activity.kind": "preparation",
            "vitehub.activity.title": "Materializing workspace",
          },
          name: "vitehub.workspace.materialization.start",
          sequence: 1,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: {
            "step.id": "vitehub.workspace.materialization:[\"docs\",\"\"]",
            "vitehub.activity.kind": "preparation",
            "vitehub.activity.title": "Workspace materialized",
          },
          name: "vitehub.workspace.materialization.completed",
          sequence: 2,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: {
            "channel.effect.intent": "started",
            "channel.effect.kind": "reaction",
          },
          name: "vitehub.channel.delivery",
          sequence: 3,
          timestamp,
          type: "lifecycle" as const,
        },
      ],
      status: "running" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    const activities = invocationActivities(invocation);
    expect(activities.map(activity => activity.kind)).toEqual(["preparation", "delivery"]);
    expect(activities.map(invocationActivityTitle)).toEqual(["Workspace materialized", "Reacted with eyes"]);
    expect(activities[0]?.status).toBe("completed");
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
            "input.messages": [
              { id: "old-user", parts: [{ text: "Earlier question", type: "text" }], role: "user" },
              { id: "old-assistant", parts: [{ text: "Earlier answer", type: "text" }], role: "assistant" },
            ],
          },
          name: "agent.invocation.started",
          sequence: 1,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: {
            "vitehub.agent.configuration": { driver: { model: { id: "gpt-5.6-sol" } } },
          },
          name: "vitehub.agent.configured",
          sequence: 2,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: {
            "vitehub.activity.detail": "vite-hub/vitehub · PR #1030",
            "vitehub.activity.kind": "preparation",
            "vitehub.activity.title": "Pull request selected",
          },
          name: "vitehub.pull-request.selected",
          sequence: 3,
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
          name: "vitehub.workspace.materialization.completed",
          sequence: 4,
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
          sequence: 5,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: { "vitehub.activity.kind": "reasoning", "vitehub.activity.body": "Checked the diff." },
          name: "agent.reasoning.finish",
          sequence: 6,
          timestamp,
          type: "lifecycle" as const,
        },
        {
          attributes: { "message.content": "Merged after checks passed.", "message.id": "assistant", "message.role": "assistant" },
          name: "agent.message",
          sequence: 7,
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
          sequence: 8,
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
    const threadItems = wrapper.findAll('[role="log"] > ol > li');

    expect(threadItems[0]!.classes()).toContain("vh-invocation-preparation");
    expect(threadItems[1]!.attributes("data-role")).toBe("user");
    expect(threadItems[1]!.text()).toContain("Earlier question");
    expect(threadItems[2]!.text()).toContain("Earlier answer");
    expect(wrapper.find('[data-kind="system"]').exists()).toBe(false);
    expect(wrapper.get(".vh-invocation-preparation__summary").text()).toContain("Session prepared");
    expect(wrapper.get(".vh-invocation-preparation__summary").text()).toContain("2 steps");
    expect(wrapper.get('.vh-invocation-preparation__context a').attributes("href")).toBe(invocation.annotations["github.url"]);
    await wrapper.get(".vh-invocation-preparation__summary").trigger("click");
    await wrapper.get('button[aria-label="Open Workspace"]').trigger("click");
    expect(wrapper.emitted("inspect")).toEqual([["workspace"]]);

    const withoutWorkspace = mount(AgentInvocation, {
      props: { invocation, workspaceInspectable: false },
    });
    await withoutWorkspace.get(".vh-invocation-preparation__summary").trigger("click");
    expect(withoutWorkspace.find('button[aria-label="Open Workspace"]').exists()).toBe(false);

    const prompt = wrapper.findAll('.vh-invocation-message[data-role="user"]').at(-1)!;
    expect(prompt.get(".vh-invocation-message__content").attributes("data-collapsed")).toBe("true");
    await prompt.get(".vh-invocation-message__more").trigger("click");
    expect(prompt.get(".vh-invocation-message__content").attributes("data-collapsed")).toBeUndefined();

    expect(wrapper.get(".vh-invocation-work__title").text()).toBe("Worked for 2m 43s");
    expect(wrapper.find(".vh-invocation-work__activities").exists()).toBe(false);
    const work = wrapper.get(".vh-invocation-work__details");
    if (!(work.element instanceof HTMLDetailsElement)) throw new TypeError("Expected work details");
    work.element.open = true;
    await work.trigger("toggle");
    expect(wrapper.get(".vh-invocation-work__activities").text()).toContain("Checked the diff.");
    expect(wrapper.findAll('.vh-invocation-message[data-role="assistant"]').at(-1)!.text()).toContain("Merged after checks passed.");
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
    expect(wrapper.get('[data-activity-id="trace-truncated"] .vh-invocation-event__title').text()).toBe("Trace content was truncated");
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

    expect(messages.map(message => message.get(".vh-invocation-message__content").text()))
      .toEqual(["First question", "First answer", "Unanswered question"]);
    expect(messages.at(-1)!.attributes("data-role")).toBe("user");
  });

  it("renders truncation after work when the latest user has no response", () => {
    const timestamp = "2026-08-24T00:00:00.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "truncated-unanswered-turn",
      observations: [{
        attributes: { "message.content": "Unanswered question", "message.id": "user", "message.role": "user" },
        name: "agent.message",
        sequence: 1,
        timestamp,
        type: "lifecycle" as const,
      }, {
        attributes: { "error.message": "Model request failed", "tool.name": "generate" },
        name: "agent.tool.error",
        sequence: 2,
        timestamp,
        type: "error" as const,
      }],
      observationsTruncated: true,
      status: "failed" as const,
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { invocation } });
    const rows = wrapper.findAll(".vh-invocation-activities > li");

    expect(rows.at(-2)?.classes()).toContain("vh-invocation-work");
    expect(rows.at(-1)?.attributes("data-activity-id")).toBe("trace-truncated");
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
    expect(wrapper.get('[data-activity-id="trace-truncated"] .vh-invocation-event__title').text()).toBe("Trace content was truncated");
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

    expect(row.get('[data-icon="check"]').attributes("data-icon")).toBe("check");
    expect(row.find(".vh-invocation-event__failure-icon").exists()).toBe(true);
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
        agent: { name: "babysitter", version: "2" },
        capabilities: [{ id: "github" }],
        channels: [{ id: "reviews", kind: "github" }],
        driver: { kind: "provider", model: { id: "gpt-5.6-sol", provider: "openai" } },
        instructions: ["Follow repository instructions."],
        runtime: { name: "node" },
        tools: [
          {
            description: "Run a shell command.",
            inputSchema: { properties: { command: { type: "string" } }, required: ["command"], type: "object" },
            name: "exec",
          },
          { description: "Search the workspace.", name: "search" },
        ],
        workspace: { mode: "write", name: "babysitter", sources: ["github:vite-hub/vitehub"] },
      },
      createdAt: "2026-08-24T00:00:00.000Z",
      id: "configured",
      observations: [
        {
          attributes: { "tool.id": "call-1", "tool.name": "exec" },
          name: "execute_tool.start",
          sequence: 1,
          timestamp: "2026-08-24T00:00:00.100Z",
          type: "run",
        },
        {
          attributes: { "tool.id": "call-1", "tool.name": "exec" },
          name: "execute_tool.finish",
          sequence: 2,
          timestamp: "2026-08-24T00:00:00.200Z",
          type: "run",
        },
      ],
      status: "completed",
      traceId: "trace",
      updatedAt: "2026-08-24T00:00:01.000Z",
    };
    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });

    expect(wrapper.get(".vh-invocation-inspector__group--execution").text()).toContain("GPT 5.6 Sol");
    expect(wrapper.get(".vh-invocation-inspector__content").text()).toContain("OpenAI");
    expect(wrapper.find(".vh-invocation-execution__model-icon path").exists()).toBe(true);
    expect(wrapper.get(".vh-invocation-execution__workspace svg").attributes("stroke")).toBe("currentColor");
    expect(wrapper.get(".vh-invocation-execution__workspace").text()).toContain("Read and write");
    expect(wrapper.get(".vh-invocation-inspector__content").text()).toContain("node");
    expect(wrapper.get(".vh-invocation-inspector__agent").text()).toContain("v2");
    expect(wrapper.get(".vh-invocation-inspector__groups").text()).toContain("reviews · github");
    expect(wrapper.findAll(".vh-invocation-inspector__content > section h4").map(node => node.text())).toContain("Agent setup");
    expect(wrapper.get(".vh-invocation-inspector__groups").text()).toContain("Instructions");
    expect(wrapper.get(".vh-agent-tool-list__disclosure").text()).toContain("Run a shell command.");
    expect(wrapper.get(".vh-agent-tool-list__schema").text()).toContain("command");
    expect(wrapper.get(".vh-invocation-inspector__group--execution").text()).toContain("GPT 5.6 Sol");
    expect(wrapper.get(".vh-invocation-inspector__group--execution").text()).toContain("OpenAI");
    expect(wrapper.get(".vh-invocation-inspector__groups").text()).toContain("1 of 2 used");
    expect(wrapper.findAll(".vh-agent-tool-list > *").map(item => item.attributes("data-used"))).toEqual(["true", "false"]);

    const namespacedModel = mount(AgentInvocationInspector, { props: {
      invocation: {
        ...invocation,
        configuration: {
          ...invocation.configuration,
          driver: { kind: "provider", model: { id: "openai/gpt-5" } },
        },
      },
    } });
    expect(namespacedModel.get(".vh-invocation-inspector__group--execution").text()).toContain("GPT 5");
    expect(namespacedModel.get(".vh-invocation-inspector__group--execution").text()).toContain("OpenAI");

    const compact = mount(AgentInvocationInspector, {
      props: { invocation, showStatus: false, showTimeline: false },
    });
    expect(compact.find(".vh-invocation-inspector__status").exists()).toBe(false);
    expect(compact.find(".vh-invocation-timeline").exists()).toBe(false);
    expect(compact.text()).toContain("Agent setup");
    const shortened = mount(AgentInvocationInspector, { props: {
      invocation: { ...invocation, configuration: { ...invocation.configuration, runtime: { name: "unknown" }, truncated: true } },
    } });
    expect(shortened.get('[role="note"]').text()).toContain("Some setup values were shortened");
    expect(shortened.get(".vh-invocation-inspector__group--execution").text()).not.toContain("unknown");

  });
});
