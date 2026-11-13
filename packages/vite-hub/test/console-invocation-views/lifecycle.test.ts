// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { AgentInvocation } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import { invocationActivities, invocationActivityTitle } from "../../src/console/runtime/components/invocation/internal/invocation-activity.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";
import { delivery, event, input, invocation, message, openDetails, openWork, threadRows, workText, workTitle } from "./fixtures.ts";

const show = (value: AgentInvocationView, props: Record<string, unknown> = {}) => mount(AgentInvocation, { props: { invocation: value, ...props } });
const configured = (configuration: Record<string, unknown>, attributes: Record<string, unknown> = {}) =>
  event("vitehub.agent.configured", { "vitehub.agent.configuration": configuration, ...attributes });
const lifecycleTitles = (wrapper: ReturnType<typeof show>) => wrapper.findAll(".vh-invocation-lifecycle__title").map(title => title.text());

describe("Agent Invocation lifecycle rows", () => {
  describe("Agent configuration", () => {
    it("renders configuration and delivery lifecycle events", async () => {
      const value = invocation([
        configured(
          { capabilities: [{ id: "db" }, { id: "blob" }], driver: { model: { id: "claude-sonnet-4-5" } }, tools: [{ name: "search" }] },
          { "vitehub.activity.body": "Agent configuration is available for inspection." },
        ),
        delivery({ "channel.effect.kind": "telegram.message.sent", "vitehub.inspect.target": "workspace" }),
      ]);
      expect(invocationActivities(value).map(activity => [activity.kind, invocationActivityTitle(activity)])).toEqual([
        ["system", "Configured Agent with 2 capabilities"],
        ["delivery", "telegram.message.sent"],
      ]);

      const wrapper = show(value);
      expect(wrapper.get(".vh-invocation-capabilities__summary").text()).toContain("Configured Agent with 2 capabilities");
      const system = wrapper.get('[data-kind="system"]');
      expect(system.get(".vh-invocation-event__suffix").text()).toBe("claude-sonnet-4-5 · 1 tool");
      // The summary only opens the row; the separate button opens the Agent inspector.
      await system.get("summary").trigger("click");
      expect(wrapper.emitted("inspect")).toBeUndefined();
      await system.get(".vh-invocation-event__inspect").trigger("click");
      // A delivery with an inspect target is one button.
      const target = wrapper.get('[data-kind="delivery"] .vh-invocation-event__summary');
      expect(target.element.tagName).toBe("BUTTON");
      await target.trigger("click");
      expect(wrapper.emitted("inspect")).toEqual([["agent"], ["workspace"]]);
    });

    it("renders only the latest resolved agent configuration", async () => {
      const wrapper = show(invocation([
        configured({ driver: { model: { id: "codex" } }, tools: [] }),
        configured({ driver: { model: { id: "gpt-6-astra" } }, tools: [{ name: "search" }, { name: "shell" }] }),
        message("user", "Inspect this session.", { "message.id": "prompt" }),
      ], { startedAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:01.000Z" }));
      await openWork(wrapper);
      const configurations = wrapper.findAll('[data-kind="system"]');
      expect(configurations).toHaveLength(1);
      expect(configurations[0]!.text()).toContain("gpt-6-astra · 2 tools");
      expect(configurations[0]!.text()).not.toContain("codex");
    });

    it("renders progress summary replacements as bordered ViteHub actions", () => {
      const value = invocation([event("agent.tool.finish", {
        "step.id": "progress-summary:2",
        "tool.id": "progress-summary:2",
        "tool.name": "vitehub_progress_summary",
        "tool.output": "Checking Airtable for assigned tasks.",
        "vitehub.action.name": "progress-summary.update",
        "vitehub.activity.body": "Checking Airtable for assigned tasks.",
        "vitehub.activity.kind": "action",
        "vitehub.activity.progress": "Checking Airtable for assigned tasks.",
        "content.omitted": ["tool.output", "vitehub.activity.body", "vitehub.activity.title"],
      })], { status: "running" });
      expect(invocationActivities(value)).toEqual([expect.objectContaining({ body: "Checking Airtable for assigned tasks.", kind: "action", status: "completed" })]);
      const action = show(value).get('.vh-invocation-activity[data-kind="action"]');
      expect(action.get(".vh-invocation-event__title").text()).toBe("Updated loading message");
      expect(action.get(".vh-invocation-event__body").text()).toBe("Checking Airtable for assigned tasks.");
    });
  });

  describe("capabilities", () => {
    const capability = (name: string, id: string, outcome = "success") => event(`agent.capability.${name}`, { "agent.capability.id": id, "agent.capability.outcome": outcome });

    it("folds consecutive capability lifecycle evidence into one quiet row", () => {
      const events = [
        input([["user", "Run it"]], {}, "agent.input"),
        capability("input", "workspace"),
        capability("output", "workspace"),
        capability("configure", "workspace"),
        capability("prepare", "sources"),
        capability("resolve", "sources"),
        capability("close", "sources", "error"),
      ];
      const group = show(invocation(events, { status: "running" })).get(".vh-invocation-capabilities__details");
      expect(group.get("summary").text()).toContain("Capability activity failed · 2 capabilities");
      expect(group.get("summary").find('[data-icon="activity"]').exists()).toBe(false);
      expect(group.findAll(".vh-invocation-capabilities__rows > li")).toHaveLength(6);
      expect(group.get('[data-activity-id="observation:7"]').attributes("data-status")).toBe("failed");
      expect((group.element as HTMLDetailsElement).open).toBe(false);

      const successful = events.map(item => ({ ...item, attributes: { ...item.attributes, "agent.capability.outcome": "success" } }));
      expect(show(invocation(successful, { status: "running" })).get(".vh-invocation-capabilities__summary").text()).toBe("Prepared 2 capabilities");
    });

    it("uses a generic capability summary when lifecycle events omit capability IDs", () => {
      const wrapper = show(invocation([event("agent.capability.configure"), event("agent.capability.prepare")], { status: "running" }));
      expect(wrapper.get(".vh-invocation-capabilities__summary").text()).toContain("Capability activity · 2 events");
    });
  });

  describe("session preparation", () => {
    const pullRequest = (url: string, number: number) => ({ "github.pullRequest": number, "github.repository": "vite-hub/vitehub", "github.url": url });

    it("groups preparation, links the pull request, and emits inspector targets", async () => {
      const prepared = invocation([
        input([["user", "Earlier question"], ["assistant", "Earlier answer"]]),
        configured({ driver: { model: { id: "gpt-5.6-sol" } } }),
        event("vitehub.pull-request.selected", { "vitehub.activity.detail": "vite-hub/vitehub · PR #1030", "vitehub.activity.kind": "preparation", "vitehub.activity.title": "Pull request selected" }),
        event("vitehub.workspace.materialization.completed", {
          "vitehub.activity.detail": "1790 files", "vitehub.activity.kind": "preparation", "vitehub.activity.title": "Workspace materialized", "vitehub.inspect.target": "workspace",
        }),
        message("user", "Review this pull request. ".repeat(50), { "message.id": "user" }),
        event("agent.reasoning.finish", { "vitehub.activity.kind": "reasoning", "vitehub.activity.body": "Checked the diff." }),
        message("assistant", "Merged after checks passed.", { "message.id": "assistant" }),
        event("vitehub.channel.delivery", { "channel.effect.intent": "started", "channel.effect.kind": "reaction", "vitehub.activity.group": "github-lifecycle" }),
      ], {
        annotations: pullRequest("https://github.com/vite-hub/vitehub/pull/1030", 1030),
        completedAt: "2026-08-22T00:02:43.000Z",
        startedAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:02:43.000Z",
      });
      const wrapper = show(prepared);
      const rows = wrapper.findAll(".vh-invocation-activities > li");
      expect(threadRows(wrapper).slice(0, 3)).toEqual(["history", "message", "work"]);
      expect(rows[0]!.text()).toContain("Earlier question");
      expect(rows[0]!.text()).toContain("Earlier answer");
      expect(rows[1]!.attributes("data-role")).toBe("user");
      expect(rows[1]!.text()).toContain("Review this pull request.");
      expect(wrapper.find('[data-kind="system"]').exists()).toBe(false);
      expect(wrapper.find(".vh-invocation-preparation").exists()).toBe(false);

      await openWork(wrapper);
      expect(wrapper.get(".vh-invocation-preparation__summary").text()).toBe("Prepared workspace");
      expect(wrapper.findAll(".vh-invocation-preparation__steps > li")).toHaveLength(2);
      await openDetails(wrapper.get(".vh-invocation-preparation__details"));
      expect(wrapper.get(".vh-invocation-preparation__steps .vh-invocation-preparation__context a").attributes("href")).toBe("https://github.com/vite-hub/vitehub/pull/1030");
      await wrapper.get('button[aria-label="Open Workspace"]').trigger("click");
      expect(wrapper.emitted("inspect")).toEqual([["workspace"]]);

      const withoutWorkspace = show(prepared, { workspaceInspectable: false });
      await openWork(withoutWorkspace);
      expect(withoutWorkspace.get(".vh-invocation-preparation__summary").text()).toBe("Prepared workspace");
      expect(withoutWorkspace.find('button[aria-label="Open Workspace"]').exists()).toBe(false);

      const prompt = wrapper.findAll('.vh-invocation-message[data-role="user"]').at(-1)!;
      expect(prompt.get(".vh-invocation-message__content").attributes("data-collapsed")).toBe("true");
      await prompt.get(".vh-invocation-message__more").trigger("click");
      expect(prompt.get(".vh-invocation-message__content").attributes("data-collapsed")).toBeUndefined();

      expect(workTitle(wrapper)).toBe("Worked for 2m 43s");
      expect(wrapper.get(".vh-invocation-work__summary").element.lastElementChild?.classList).toContain("vh-invocation-work__disclosure");
      expect(wrapper.find(".vh-invocation-work__summary .vh-invocation-framework-mark").exists()).toBe(false);
      expect(wrapper.get(".vh-invocation-framework-mark").attributes("style")).toBeUndefined();
      expect(workText(wrapper)).toContain("Checked the diff.");
      expect(wrapper.findAll('.vh-invocation-message[data-role="assistant"]').at(-1)!.text()).toContain("Merged after checks passed.");
      expect(wrapper.find('[data-kind="delivery"]').exists()).toBe(true);
    });

    it("renders unsafe pull request annotations as text and failed preparation as failed", () => {
      const wrapper = show(invocation([event("vitehub.workspace.error", {
        "error.message": "Workspace checkout failed",
        "vitehub.observation.truncated": true,
        "vitehub.activity.kind": "preparation",
        "vitehub.activity.title": "Workspace failed",
      })], { annotations: pullRequest("javascript:alert(1)", 1040), status: "failed" }));
      expect(wrapper.get(".vh-invocation-preparation__summary").text()).toContain("Session preparation failed");
      expect(wrapper.find(".vh-invocation-preparation__context a").exists()).toBe(false);
      expect(wrapper.get(".vh-invocation-preparation__context").text()).toContain("PR #1040");
      expect(wrapper.get(".vh-invocation-preparation__body").text()).toBe("Workspace checkout failed");
      expect(wrapper.get(".vh-invocation-preparation__step").attributes("data-status")).toBe("failed");
      expect(wrapper.get(".vh-invocation-preparation__steps .vh-invocation-event__notice").text()).toContain("Part of this activity was shortened when it was recorded.");
    });
  });

  describe("grouped lifecycle", () => {
    const grouped = (name: string, attributes: Record<string, unknown>, group = "github-lifecycle") => event(name, { "vitehub.activity.group": group, ...attributes });

    it("keeps adjacent completed lifecycle activities grouped", async () => {
      const wrapper = show(invocation([
        message("user", "Run it.", { "message.id": "user" }),
        grouped("github.first", {}, "github-completion"),
        grouped("github.second", {}, "github-completion"),
      ]));
      await openWork(wrapper);
      expect(wrapper.findAll(".vh-invocation-lifecycle")).toHaveLength(1);
      expect(wrapper.findAll(".vh-invocation-lifecycle li")).toHaveLength(2);
    });

    it("groups adjacent lifecycle activities after their observations collapse", () => {
      const step = (name: string, phase: string) => grouped(`vitehub.github.${name}.${phase}`, { "step.id": name, "vitehub.activity.kind": "action", "vitehub.activity.title": name });
      const wrapper = show(invocation([step("first", "started"), step("first", "completed"), step("second", "started"), step("second", "completed")], { status: "running" }));
      expect(wrapper.findAll('[data-activity-group="github-lifecycle"]')).toHaveLength(1);
      expect(wrapper.findAll('[data-activity-group="github-lifecycle"] .vh-invocation-lifecycle__row')).toHaveLength(2);
    });

    it("groups consecutive lifecycle rows and renders structured GitHub labels", () => {
      const label = (event: string, name: string, color: string, operation: string, title: string, group?: string) => grouped(`vitehub.github.label.${event}`, {
        "github.label.color": color, "github.label.name": name, "github.label.operation": operation, "vitehub.activity.kind": "action", "vitehub.activity.title": title,
      }, group);
      const status = (event: string, kind: string, intent: string, title: string, group?: string) => grouped(`vitehub.github.${event}`, {
        "channel.effect.intent": intent, "channel.effect.kind": kind, "vitehub.activity.kind": "delivery", "vitehub.activity.title": title,
      }, group);
      const wrapper = show(invocation([
        label("queued", "Agent: Queued", "d0d7de", "add", "Queued label added"),
        label("working", "Agent: Working", "54aeff", "add", "Working label added"),
        status("status.started", "status", "started", "Working status posted"),
        status("reaction.started", "reaction", "started", "Reacted with eyes"),
        label("removed", "Agent: Working", "54aeff", "remove", "Working label removed", "github-completion"),
        status("status.finished", "update", "completed", "GitHub result posted", "github-completion"),
      ], { status: "running" }));
      const groups = wrapper.findAll(".vh-invocation-lifecycle");

      expect(groups.map(group => group.findAll(".vh-invocation-lifecycle__row").length)).toEqual([4, 2]);
      expect(groups[0]!.findAll(".vh-invocation-lifecycle__label").map(chip => chip.text())).toEqual(["Agent: Queued", "Agent: Working"]);
      expect(groups[0]!.findAll(".vh-invocation-lifecycle__title").slice(0, 2).map(title => title.text())).toEqual(["Added label", "Added label"]);
      expect(groups[0]!.get(".vh-invocation-lifecycle__label").attributes("style")).toContain("#d0d7de");
      expect(groups[0]!.get(".vh-invocation-lifecycle__emoji").text()).toBe("👀");
      expect(groups[1]!.get(".vh-invocation-lifecycle__title").text()).toBe("Removed label");
      expect(groups[1]!.get(".vh-invocation-lifecycle__label").attributes("data-operation")).toBe("remove");
    });

    it("renders grouped delivery outcomes, reaction intents, and truncation honestly", () => {
      const outcome = (attributes: Record<string, unknown>) => grouped("vitehub.channel.delivery", { "vitehub.activity.kind": "delivery", ...attributes });
      const wrapper = show(invocation([
        outcome({ "channel.effect.kind": "reply", "channel.effect.supported": false }),
        outcome({ "channel.effect.kind": "status", "channel.effect.skipped": "missing target" }),
        outcome({ "channel.effect.intent": "completed", "channel.effect.kind": "reaction" }),
        outcome({ "channel.effect.intent": "failed", "channel.effect.kind": "reaction" }),
      ], { observationsTruncated: true, status: "running" }));
      expect(lifecycleTitles(wrapper)).toEqual(["Reply not supported", "Status skipped", "Reacted with hooray", "Reacted with confused"]);
      expect(wrapper.findAll(".vh-invocation-lifecycle__emoji").map(emoji => [emoji.text(), emoji.attributes("aria-label")])).toEqual([["🎉", "hooray"], ["😕", "confused"]]);
      expect(wrapper.get('[data-activity-id="trace-truncated"] .vh-invocation-event__title').text()).toBe("Trace content was truncated");
    });

    it("exposes grouped lifecycle failures", () => {
      const wrapper = show(invocation([grouped("vitehub.github.label.error", {
        "error.message": "GitHub rejected the label update",
        "github.label.name": "Agent: Working",
        "github.label.operation": "add",
        "vitehub.activity.kind": "action",
        "vitehub.activity.title": "Added label",
      })], { status: "running" }));
      const row = wrapper.get('[data-activity-group="github-lifecycle"] [data-status="failed"]');
      expect(row.find('[data-icon="check"]').exists()).toBe(true);
      expect(row.find(".vh-invocation-event__failure-icon").exists()).toBe(true);
      expect(row.get(".vh-invocation-lifecycle__title").text()).toBe("Failed to add label");
      expect(row.get(".vh-invocation-lifecycle__failure").text()).toBe("GitHub rejected the label update");
      expect(row.get(".vh-invocation-lifecycle__label").text()).toBe("Agent: Working");
    });
  });
});
