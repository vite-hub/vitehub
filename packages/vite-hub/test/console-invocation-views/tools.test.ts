// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import { AgentInvocation, AgentInvocationInspector } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import { invocationActivities, invocationActivityTitle } from "../../src/console/runtime/components/invocation/internal/invocation-activity.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";
import { activityTitles, clipboard, delta, event, input, invocation, openDetails, openWork, tool } from "./fixtures.ts";

const show = (value: AgentInvocationView, props: Record<string, unknown> = {}) => mount(AgentInvocation, { props: { invocation: value, ...props } });
const commandRun = (id: string, command: Record<string, unknown>, fields: Record<string, unknown> = {}) => tool("finish", id, "Ran command", { "tool.input": command, ...fields });

describe("Agent Invocation tool steps", () => {
  describe("commands", () => {
    it("renders failed command diagnostics with command details", () => {
      const wrapper = show(invocation([
        tool("start", "command", "shell", { "tool.input": { command: "pnpm test" } }),
        tool("error", "command", "shell", { "tool.error": "Command timed out" }),
      ], { status: "failed" }));
      expect(wrapper.get(".vh-invocation-command__bar code").text()).toBe("pnpm test");
      expect(wrapper.find('.vh-invocation-event__icon[data-icon="command"]').exists()).toBe(true);
      expect(wrapper.find(".vh-invocation-event__failure-icon").exists()).toBe(true);
      expect(wrapper.get(".vh-invocation-command .vh-invocation-event__payload > strong").text()).toBe("Error");
      expect(wrapper.get(".vh-invocation-command .vh-invocation-event__payload pre").text()).toBe("Command timed out");
    });

    it("includes failure in a collapsed activity's accessible text", () => {
      const wrapper = show(invocation([event("agent.tool.error", { "tool.name": "Search" })], { status: "failed" }));
      expect(wrapper.get('[data-status="failed"] .vh-visually-hidden').text()).toBe("Failed");
    });

    it("shows Codex steps as the commands and tools the agent ran", async () => {
      const usage = (reasoningTokens?: number) => event("agent.usage.recorded", { "usage.model": "gpt-6", "usage.provider": "codex", ...reasoningTokens ? { "usage.reasoningTokens": reasoningTokens } : {} });
      const wrapper = show(invocation([
        input([["user", "Check the thread"]], {}, "agent.input"),
        tool("start", "cat", "command_execution", { "tool.input": { command: "/bin/sh -lc 'cat AGENTS.md; echo '\\''done'\\'''", toolName: "command_execution" }, "tool.title": "cat AGENTS.md; echo 'done'" }),
        usage(),
        delta("assistant", "I’ll check the earlier conversation.", { "message.id": "progress", "message.phase": "final" }),
        tool("start", "threads", "t3-code.mcp_productlane_threads_get"),
        tool("start", "resources", "codex.list_mcp_resources"),
        usage(),
        usage(181),
        delta("assistant", "Done.", { "message.id": "answer", "message.phase": "final" }),
      ], { completedAt: "2026-08-22T00:01:00.000Z", startedAt: "2026-08-22T00:00:00.000Z" }));
      await openWork(wrapper);
      const steps = wrapper.findAll(".vh-invocation-work__activities > li");
      expect(steps.map(step => step.find(".vh-invocation-event__title").exists() ? step.get(".vh-invocation-event__title").text() : step.get(".vh-invocation-message__content").text())).toEqual([
        "Ran command",
        "I’ll check the earlier conversation.",
        "Productlane threads get",
        "List MCP resources",
        "Thinking",
      ]);
      expect(steps[0]!.get(".vh-invocation-event__suffix").text()).toBe("cat AGENTS.md; echo 'done'");
      expect(steps[4]!.get(".vh-invocation-event__suffix").text()).toBe("181 tokens");
      expect(steps[1]!.find(".vh-invocation-message__meta").exists()).toBe(false);
    });

    it("keeps the last empty model step of a live session", () => {
      const wrapper = show(invocation([
        input([["user", "Check the thread"]], {}, "agent.input"),
        tool("start", "cat", "command_execution", { "tool.input": { command: "ls", toolName: "command_execution" }, "tool.title": "ls" }),
        event("agent.usage.recorded", { "usage.provider": "codex" }),
      ], { startedAt: "2026-08-22T00:00:00.000Z", status: "running" }));
      expect(activityTitles(wrapper.get(".vh-invocation-work__activities"))).toEqual(["Ran command", "Thinking"]);
    });

    it("formats token counts with a stable locale", () => {
      const value = invocation([event("agent.usage.recorded", { "usage.reasoningTokens": 1_200, "usage.totalTokens": 12_345 })]);
      expect(show(value).text()).toContain("1.2K tokens");
      expect(mount(AgentInvocationInspector, { props: { invocation: value } }).text()).toContain("12,345");
    });

    it("does not present missing reasoning usage as zero tokens", () => {
      const wrapper = show(invocation([event("agent.usage.recorded", { "usage.reasoningTokens": 0, "usage.totalTokens": 12_345 })]));
      expect(wrapper.text()).not.toContain("0 tokens");
      expect(wrapper.find('[data-kind="model"] [data-icon="brain"]').exists()).toBe(true);
    });
  });

  describe("labels and icons", () => {
    it("uses declared tool labels and icons from the configuration catalog", () => {
      const value = invocation([
        tool("finish", "meal", "search_meals"),
        tool("finish", "provider", "search_meals", { "tool.title": "Provider title" }),
        tool("finish", "schema", "db_schema"),
      ], { configuration: {
        driver: { kind: "model" },
        runtime: { name: "node" },
        tools: [{ icon: "i-lucide-utensils", label: "Searched meals", name: "search_meals" }, { name: "db_schema" }],
      } });
      expect(invocationActivities(value).map(activity => [invocationActivityTitle(activity), activity.toolDisplay?.icon])).toEqual([
        ["Searched meals", "i-lucide-utensils"],
        ["Provider title", "i-lucide-utensils"],
        ["Db schema", undefined],
      ]);

      const UIcon = defineComponent({ props: { name: { required: true, type: String } }, setup: props => () => h("svg", { "data-name": props.name }) });
      const withIcons = mount(AgentInvocation, { global: { components: { UIcon } }, props: { invocation: value } });
      expect(withIcons.findAll('.vh-invocation-event__icon[data-icon="i-lucide-utensils"] svg[data-name="i-lucide-utensils"]')).toHaveLength(2);
      expect(show(value).find('.vh-invocation-event__icon[data-icon="i-lucide-utensils"]').exists()).toBe(false);

      const row = mount(AgentInvocationInspector, { global: { components: { UIcon } }, props: { invocation: value } }).get('.vh-agent-tool-list [data-used="true"]');
      expect(row.get("small").text()).toBe("Searched meals");
      expect(row.get(".vh-agent-tool-list__icon svg").attributes("data-name")).toBe("i-lucide-utensils");
    });

    it("presents image-view tools as one readable disclosure", () => {
      const row = show(invocation([tool("finish", "image", "Image view", {
        "tool.input": { item: { id: "exec-9f5", path: "/tmp/source-map.png", type: "imageView" } },
        "tool.output": { completedAtMs: 1_788_851, item: { path: "/tmp/source-map.png" } },
      })])).get('[data-activity-id="image"]');
      expect(row.get(".vh-invocation-event__title").text()).toBe("View image");
      expect(row.get(".vh-invocation-event__suffix").text()).toBe("source-map.png");
      expect(row.find('[data-icon="eye"]').exists()).toBe(true);
      expect(row.findAll("details")).toHaveLength(1);
      expect(row.findAll(".vh-invocation-event__payload")).toHaveLength(0);
      expect(row.get(".vh-invocation-image-details").text()).toContain("/tmp/source-map.png");
      expect(row.get(".vh-invocation-image-details pre").text()).toContain('"completedAtMs": 1788851');
    });
  });

  describe("skill reads", () => {
    it("links structured workspace skill reads without inferring them from command text", async () => {
      const skillPath = ".agents/skills/quiver-evidence/SKILL.md";
      const value = invocation([
        commandRun("skill", { item: {
          command: `/bin/sh -lc 'cat ${skillPath}'`,
          commandActions: [{ command: `cat ${skillPath}`, name: "SKILL.md", path: `/workspace/capsule/${skillPath}`, type: "read" }],
          cwd: "/workspace/capsule",
        } }),
        commandRun("mention-only", { command: "echo .agents/skills/not-used/SKILL.md" }),
        ...["../outside", ".agents/skills/../other/SKILL.md", ".agents//skills/other/SKILL.md", ".agents\\skills\\other\\SKILL.md"]
          .map((path, index) => commandRun(`invalid-skill-${index}`, { item: { commandActions: [{ path, type: "read" }], cwd: "/workspace/capsule" } })),
      ]);
      const activities = invocationActivities(value);
      expect(activities[0]?.skill).toEqual({ name: "quiver-evidence", path: skillPath });
      expect(invocationActivityTitle(activities[0]!)).toBe("Read quiver-evidence skill");
      expect(activities.slice(1).every(activity => activity.skill === undefined)).toBe(true);

      const wrapper = show(value);
      await wrapper.get('[data-activity-id="skill"] .vh-invocation-event__title-link').trigger("click");
      expect(wrapper.emitted("inspect")).toEqual([["workspace", skillPath]]);
      expect(show(value, { workspaceInspectable: false }).find(".vh-invocation-event__title-link").exists()).toBe(false);
    });

    it("links every literal skill path in a structured cat action", async () => {
      const value = invocation([
        commandRun("cat-skills", { item: { commandActions: [{ command: "cat AGENTS.md .agents/skills/show-me/SKILL.md .agents/skills/unslop/SKILL.md", type: "unknown" }], cwd: "/workspace/capsule" } }),
        commandRun("not-cat", { item: { commandActions: [{ command: "echo .agents/skills/not-read/SKILL.md", type: "unknown" }] } }),
      ]);
      const activities = invocationActivities(value);
      expect(activities[0]?.skills).toEqual([
        { name: "show-me", path: ".agents/skills/show-me/SKILL.md" },
        { name: "unslop", path: ".agents/skills/unslop/SKILL.md" },
      ]);
      expect(activities[1]?.skills).toBeUndefined();

      const wrapper = show(value);
      const links = wrapper.findAll('[data-activity-id="cat-skills"] .vh-invocation-event__title-link');
      expect(links.map(link => link.text())).toEqual(["Read show-me skill", "Read unslop skill"]);
      expect(wrapper.find('[data-activity-id="cat-skills"] .vh-invocation-event__disclosure').exists()).toBe(true);
      for (const link of links) await link.trigger("click");
      expect(wrapper.emitted("inspect")).toEqual([["workspace", ".agents/skills/show-me/SKILL.md"], ["workspace", ".agents/skills/unslop/SKILL.md"]]);
    });

    it("forwards each skill path that a tool output records", async () => {
      const wrapper = show(invocation([event("agent.tool.completed", { "tool.name": "read", "tool.output": { commandActions: [
        { type: "read", path: ".agents/skills/first/SKILL.md" },
        { type: "read", path: ".agents/skills/second/SKILL.md" },
      ] } })], { status: "running" }));
      const buttons = wrapper.findAll("button").filter(button => button.text().startsWith("Read "));
      expect(buttons).toHaveLength(2);
      for (const button of buttons) await button.trigger("click");
      expect(wrapper.emitted("inspect")).toEqual([["workspace", ".agents/skills/first/SKILL.md"], ["workspace", ".agents/skills/second/SKILL.md"]]);
    });
  });

  describe("payloads", () => {
    /** A run with a timed ViteHub preparation step and a database query that returns an error. */
    const timedRun = invocation([
      tool("start", "materialize", "materialize_sources", {
        "step.id": "materialize", "tool.input": { path: "workspace root" },
        "vitehub.activity.kind": "preparation", "vitehub.activity.title": "Materialized ViteHub workspace",
      }, { timestamp: "2026-08-22T00:00:00.250Z" }),
      tool("finish", "materialize", "materialize_sources", {
        "step.id": "materialize", "tool.durationMs": 500, "tool.output": { files: 12, summary: "Materialized repository (12 files)." },
      }, { timestamp: "2026-08-22T00:00:00.750Z" }),
      tool("start", "query", "database_query", { "tool.input": { summary: "Private query omitted." } }, { timestamp: "2026-08-22T00:00:01.000Z" }),
      tool("finish", "query", "database_query", { "tool.error": "Result was incomplete.", "tool.output": "  Returned 1 row.\n" }, { timestamp: "2026-08-22T00:00:02.000Z" }),
    ], { completedAt: "2026-08-22T00:00:03.000Z", startedAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:03.000Z" });

    it("times each step from its start and finish", () => {
      expect(invocationActivities(timedRun)).toEqual([
        expect.objectContaining({ durationMs: 500, endedAt: "2026-08-22T00:00:00.750Z", preview: "Materialized repository (12 files).", startedAt: "2026-08-22T00:00:00.250Z" }),
        expect.objectContaining({ durationMs: 1_000, startedAt: "2026-08-22T00:00:01.000Z" }),
      ]);
    });

    it("explores, searches and copies a structured tool payload", async () => {
      const thread = show(timedRun);
      expect(thread.findAll(".vh-invocation-event__payload > summary > strong").map(item => item.text())).toEqual(["Input", "Output", "Error"]);
      for (const text of ["Private query omitted.", "Returned 1 row.", "Result was incomplete."]) expect(thread.text()).toContain(text);
      const payload = thread.findAll(".vh-invocation-event__payload")[0]!;
      expect(payload.get("summary code").text()).toContain("Private query omitted.");
      expect(payload.find(".vh-invocation-payload__content").exists()).toBe(false);
      await openDetails(payload);
      expect(payload.findAll(".vh-invocation-payload__key").map(item => item.text())).toContain("summary");
      await payload.get('button[aria-pressed="false"]').trigger("click");
      expect(payload.get("pre").text()).toContain('"summary": "Private query omitted."');
      await payload.get('input[type="search"]').setValue("missing");
      await payload.get('button[aria-pressed="false"]').trigger("click");
      expect(payload.text()).toContain("No matching fields");
      const writeText = vi.fn().mockResolvedValue(undefined);
      clipboard(writeText);
      await payload.get(".vh-invocation-payload__copy").trigger("click");
      expect(writeText).toHaveBeenCalledWith('{\n  "summary": "Private query omitted."\n}');
      await vi.waitFor(() => expect(payload.get(".vh-invocation-payload__copy").text()).toBe("Copied"));
    });

    it("lists timed steps in the inspector and selects one in the thread", async () => {
      const inspector = mount(AgentInvocationInspector, { props: { invocation: timedRun } });
      const rows = inspector.findAll(".vh-invocation-timeline__row");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.attributes()).toMatchObject({ "data-owner": "vitehub", title: "Materialized ViteHub workspace — Materialized repository (12 files)." });
      expect(rows[0]!.text()).toContain("+250ms · 500ms");
      expect(rows[1]!.attributes("data-owner")).toBe("agent");
      expect(rows[1]!.text()).toContain("+1s · 1s");
      await rows[1]!.trigger("click");
      expect(inspector.emitted("selectActivity")).toEqual([[rows[1]!.attributes("data-activity-id")]]);

      const selectedId = rows[0]!.attributes("data-activity-id");
      const selected = show(timedRun, { selectedActivityId: selectedId });
      await nextTick();
      const selectedEvent = selected.get(`[data-activity-id="${selectedId}"]`);
      expect(selectedEvent.attributes("data-selected")).toBe("true");
      expect(selectedEvent.element.closest("details")).toHaveProperty("open", true);
      await selected.setProps({ selectedActivityId: undefined });
      await selected.setProps({ selectedActivityId: selectedId });
      await nextTick();
      expect(selected.get(`[data-activity-id="${selectedId}"]`).attributes("data-selected")).toBe("true");
    });

    it("keeps the selected step open in the work when the run completes", async () => {
      const prompted = { ...timedRun, observations: [
        { attributes: { "message.content": "Inspect the repository", "message.id": "user", "message.role": "user" }, name: "agent.message", sequence: 0, timestamp: timedRun.startedAt!, type: "lifecycle" as const },
        ...timedRun.observations,
      ] };
      const selectedId = invocationActivities(prompted).find(activity => activity.kind === "tool")!.id;
      const wrapper = show({ ...prompted, status: "running" }, { selectedActivityId: selectedId });
      await nextTick();
      const element = wrapper.get(`[data-activity-id="${selectedId}"]`).element;
      if (!(element instanceof HTMLElement)) throw new TypeError("Expected an HTML element");
      const focus = vi.spyOn(element, "focus");
      await wrapper.setProps({ invocation: { ...prompted, status: "running" } });
      await nextTick();
      expect(focus).not.toHaveBeenCalled();
      await wrapper.setProps({ invocation: prompted });
      await nextTick();
      const regrouped = wrapper.get(`[data-activity-id="${selectedId}"]`);
      expect(regrouped.attributes("data-selected")).toBe("true");
      expect(regrouped.element.closest(".vh-invocation-work__details")).toHaveProperty("open", true);
    });

    it("bounds large payload trees and safely serializes repeated and circular values", async () => {
      const shared = { value: "shared" };
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const fields = (prefix: string, count: number, value?: string) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}${index}`, value ?? index]));
      const inspected = (toolInput: unknown, status: AgentInvocationView["status"] = "running", extra: ReturnType<typeof tool>[] = []) =>
        show(invocation([tool("start", "inspect", "inspect", { "tool.input": toolInput }), ...extra], { status })).findAll(".vh-invocation-event__payload")[0]!;

      const payload = inspected(
        { big: 12n, circular, fields: fields("field", 800), siblings: fields("sibling", 800), first: shared, second: shared },
        "completed",
        [tool("finish", "inspect", "inspect", { "tool.output": { ok: true } })],
      );
      expect(payload.find(".vh-invocation-payload__tree").exists()).toBe(false);
      await openDetails(payload);
      expect(payload.findAll("li")).toHaveLength(500);
      expect(payload.text()).toContain("More fields hidden");
      await payload.get('button[aria-pressed="false"]').trigger("click");
      const raw = payload.get("pre").text();
      expect(raw.match(/"value": "shared"/g)).toHaveLength(2);
      expect(raw).toContain('"self": "[Circular]"');
      expect(raw).toContain('"big": "12n"');

      const deep = inspected(Array.from({ length: 11 }).reduce<Record<string, unknown>>(value => ({ nested: value }), { needle: "visible boundary" }));
      await openDetails(deep);
      await deep.get('input[type="search"]').setValue("visible boundary");
      expect(deep.text()).toContain("$.nested");

      const search = inspected({ empty: {}, matches: fields("match", 501, "needle") });
      await openDetails(search);
      await search.get('input[type="search"]').setValue("empty");
      expect(search.text()).toContain("$.empty");
      await search.get('input[type="search"]').setValue("needle");
      expect(search.findAll(".vh-invocation-payload__matches li")).toHaveLength(501);
      expect(search.text()).toContain("More matches hidden. Refine your search.");
    });

    it("renders unsafe payloads before a tool reaches a terminal state", () => {
      const toolInput = { toJSON() { throw new Error("serialization failed"); } };
      expect(show(invocation([tool("start", "inspect", "inspect", { "tool.input": toolInput })], { status: "running" })).text()).toContain("Unable to display payload: serialization failed");
    });
  });
});
