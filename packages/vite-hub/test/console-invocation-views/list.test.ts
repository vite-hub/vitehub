// @vitest-environment happy-dom

import { mount, type VueWrapper } from "@vue/test-utils";
import { h, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import { AgentInvocationList } from "../../src/console/runtime/components/invocation/agent-invocation-list.ts";
import type { AgentInvocationListItem, AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";
import { underfilled } from "./fixtures.ts";

const item = (id: string, status: AgentInvocationListItem["status"], fields: Partial<AgentInvocationListItem> = {}): AgentInvocationListItem => ({ id, status, title: id, ...fields });
const rows = (count: number) => Array.from({ length: count }, (_, index) => item(`inv-${index}`, "completed", { title: `Invocation ${index}` }));
const titles = (wrapper: VueWrapper) => wrapper.findAll(".vh-invocation-list__title").map(title => title.text());
const state = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-invocation-id="${id}"] .vh-invocation-list__state`);

describe("Agent Invocation list", () => {
  describe("rows", () => {
    it("keeps sessions in API order without lifecycle groups, headings, counts or disclosures", () => {
      const items = [
        item("done-old", "completed", { updatedAt: "2026-08-20T00:00:00Z" }),
        item("queued-old", "pending", { updatedAt: "2026-08-21T00:00:00Z" }),
        item("working-old", "running", { updatedAt: "2026-08-22T00:00:00Z" }),
        item("done-new", "failed", { updatedAt: "2026-08-24T00:00:00Z" }),
        item("queued-new", "pending", { updatedAt: "2026-08-25T00:00:00Z" }),
        item("working-new", "running", { updatedAt: "2026-08-26T00:00:00Z" }),
      ];
      const wrapper = mount(AgentInvocationList, { props: { hasMore: true, items } });
      expect(titles(wrapper)).toEqual(items.map(row => row.title));
      expect(wrapper.find(".vh-invocation-list__group").exists()).toBe(false);
      expect(wrapper.find(".vh-invocation-list__group-count").exists()).toBe(false);
      expect(wrapper.find("details").exists()).toBe(false);
    });

    it("groups sessions by recency in local calendar days when asked", async () => {
      const now = new Date(2026, 9, 6, 10, 0).getTime();
      const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).toISOString();
      const items = [
        item("old", "completed", { updatedAt: new Date(2026, 8, 28, 23).toISOString() }),
        item("today-late", "running", { startedAt: at(5), updatedAt: at(6, 9) }),
        item("yesterday", "failed", { updatedAt: at(5, 0) }),
        item("week", "completed", { updatedAt: at(2) }),
        item("undated", "pending"),
        item("today-early", "completed", { updatedAt: at(6, 0) }),
      ];
      const wrapper = mount(AgentInvocationList, { props: { groupBy: "recency", items, now, selectedId: "week" } });
      await nextTick();
      const groups = wrapper.findAll(".vh-invocation-list__group");
      expect(groups.map(group => group.get("h3").text())).toEqual(["Today", "Yesterday", "Previous 7 days", "Older"]);
      expect(groups.map(group => group.findAll(".vh-invocation-list__item").map(row => row.attributes("data-invocation-id"))))
        .toEqual([["today-late", "today-early"], ["yesterday"], ["week"], ["old", "undated"]]);
      expect(wrapper.get('[data-invocation-id="week"]').attributes("aria-current")).toBe("true");
    });

    it("stays flat when recency grouping has no clock", () => {
      const wrapper = mount(AgentInvocationList, { props: { groupBy: "recency", items: [item("one", "completed", { updatedAt: "2026-10-06T00:00:00Z" })] } });
      expect(wrapper.find(".vh-invocation-list__group").exists()).toBe(false);
      expect(wrapper.findAll(".vh-invocation-list__item")).toHaveLength(1);
    });

    it.each([undefined, "Header"])("keeps every session in the accessible navigation list (header: %s)", (header) => {
      const items = rows(100).map((row, index) => index ? row : { ...row, description: "The host stopped before this invocation finished." });
      const wrapper = mount(AgentInvocationList, { props: { items }, slots: header ? { header } : {} });
      if (header) expect(wrapper.text()).toContain(header);
      expect(wrapper.findAll("li")).toHaveLength(100);
      expect(state(wrapper, "inv-0").attributes("title")).toBe("The host stopped before this invocation finished.");
    });

    it("shows only the project line above the title", () => {
      const wrapper = mount(AgentInvocationList, { props: { items: [
        item("finished", "completed", { title: "Support session", project: "Console", agent: "Helper", provider: "OpenAI" }),
        item("bare", "completed"),
      ] } });
      const [row, bare] = wrapper.findAll("button");
      expect(row!.get(".vh-invocation-list__project").text()).toBe("Console");
      expect(row!.find(".vh-invocation-list__harness").exists()).toBe(false);
      expect(row!.find(".vh-invocation-list__meta").exists()).toBe(false);
      expect(bare!.find(".vh-invocation-list__project").exists()).toBe(false);
    });

    it("renders flat-list project and harness slots with the invocation item", () => {
      const custom = item("custom", "completed", { agent: "Default agent", provider: "Default provider" });
      const wrapper = mount(AgentInvocationList, {
        props: { items: [custom] },
        slots: {
          harness: ({ item: slotItem }) => h("span", { "data-slot-item": slotItem.id }, "Custom harness"),
          projectIcon: ({ item: slotItem }) => h("span", { "data-slot-item": slotItem.id }, "Custom project"),
        },
      });
      expect(wrapper.get(".vh-invocation-list__project-icon").text()).toBe("Custom project");
      expect(wrapper.get(".vh-invocation-list__project-icon [data-slot-item]").attributes("data-slot-item")).toBe(custom.id);
      expect(wrapper.text()).not.toContain("Default agent");
      expect(wrapper.text()).not.toContain("Default provider");
      expect(wrapper.get(".vh-invocation-list__harness").text()).toBe("Custom harness");
      expect(wrapper.get(".vh-invocation-list__harness [data-slot-item]").attributes("data-slot-item")).toBe(custom.id);
    });

    it("puts the state on the title line when a row has no project", () => {
      const wrapper = mount(AgentInvocationList, { props: { items: [item("plain", "pending", { title: "Plain" }), item("project", "pending", { project: "vitehub" })] } });
      expect(wrapper.find('[data-invocation-id="plain"] .vh-invocation-list__context').exists()).toBe(false);
      expect(wrapper.get('[data-invocation-id="plain"] .vh-invocation-list__headline').text()).toBe("PlainQueued");
      expect(wrapper.get('[data-invocation-id="project"] .vh-invocation-list__context').text()).toBe("vitehubQueued");
      expect(wrapper.find('[data-invocation-id="project"] .vh-invocation-list__headline').exists()).toBe(false);
    });
  });

  describe("status", () => {
    it.each(["unknown", "constructor", "toString", "__proto__"])("renders persisted status %s as Unknown", (value) => {
      const wrapper = mount(AgentInvocationList, { props: { items: [item("unknown-status", value as AgentInvocationView["status"])] } });
      expect(state(wrapper, "unknown-status").text()).toContain("Unknown");
    });

    it("shows active and failed statuses while visually hiding completed status", () => {
      const wrapper = mount(AgentInvocationList, { props: { items: [item("done", "completed"), item("queued", "pending"), item("failed", "failed")] } });
      expect(state(wrapper, "done").text()).toBe("Done");
      expect(state(wrapper, "done").get('[data-slot="visually-hidden"]').text()).toBe("Done");
      expect(state(wrapper, "done").find(".vh-invocation-list__state-icon").exists()).toBe(false);
      expect(state(wrapper, "queued").text()).toBe("Queued");
      expect(state(wrapper, "failed").text()).toBe("Failed");
    });

    it("shows the loader-circle spinner for working sessions", () => {
      const wrapper = mount(AgentInvocationList, { props: { items: [item("running", "running")] } });
      expect(wrapper.get('[data-status="running"] .vh-invocation-list__state-icon path').attributes("d")).toBe("M21 12a9 9 0 1 1-6.219-8.56");
    });

    it.each(["failed", "cancelled"] as const)("exposes the %s reason on the focusable session button", (status) => {
      const wrapper = mount(AgentInvocationList, { props: { items: [item("terminal", status, { description: "Provider disconnected" })] } });
      expect(wrapper.get('button[data-invocation-id="terminal"]').attributes("aria-description")).toBe("Provider disconnected");
    });

    it("keeps a selected terminal session marked as current", () => {
      const wrapper = mount(AgentInvocationList, { props: { items: [item("done", "completed")], selectedId: "done" } });
      expect(wrapper.get('[data-invocation-id="done"]').attributes("aria-current")).toBe("true");
    });

    it.each([
      ["pending", "running", "moving"],
      ["running", "completed", "moving"],
      ["running", "completed", undefined],
    ] as const)("keeps focus when a session moves from %s to %s (selected: %s)", async (before, after, selectedId) => {
      const wrapper = mount(AgentInvocationList, { attachTo: document.body, props: { items: [item("moving", before)], selectedId } });
      wrapper.get<HTMLButtonElement>('[data-invocation-id="moving"]').element.focus();
      await wrapper.setProps({ items: [item("moving", after)] });
      await nextTick();
      expect(document.activeElement).toBe(wrapper.get('[data-invocation-id="moving"]').element);
      wrapper.unmount();
    });
  });

  describe("dates", () => {
    it("renders fallback dates in UTC for hydration stability", () => {
      const wrapper = mount(AgentInvocationList, { props: { items: [item("old", "completed", { updatedAt: "2026-08-23T00:30:00.000Z" })], now: Date.parse("2026-08-25T00:30:00.000Z") } });
      expect(wrapper.get("time").text()).toBe("Aug 23");
    });

    it("expands compact running times and uses their source timestamp", () => {
      const startedAt = "2026-08-23T09:15:00.000Z";
      const wrapper = mount(AgentInvocationList, { props: { items: [item("running", "running", { startedAt, updatedAt: "2026-08-23T09:19:00.000Z" })], now: Date.parse("2026-08-23T09:20:00.000Z") } });
      expect(wrapper.get("time").attributes()).toMatchObject({ "aria-label": "5 minutes ago", datetime: startedAt, title: "5 minutes ago" });
      expect(wrapper.get("time").text()).toBe("5m");
    });
  });

  describe("pagination", () => {
    it("announces loading without replacing the session navigation", () => {
      const wrapper = mount(AgentInvocationList, { props: { items: [item("one", "completed")], loading: true } });
      expect(wrapper.get("nav").attributes("aria-busy")).toBeUndefined();
      expect(wrapper.get(".vh-invocation-list__group-items").attributes("aria-busy")).toBe("true");
      expect(wrapper.get('[role="status"]').text()).toBe("Loading sessions…");
      expect(wrapper.get('[role="status"]').element.closest('[aria-busy="true"]')).toBeNull();
      expect(wrapper.findAll("li")).toHaveLength(1);
    });

    it("settles repeated page failures until the consumer changes the retry key", async () => {
      const wrapper = mount(AgentInvocationList, { props: { hasMore: true, items: rows(20), retryKey: 0 } });
      const viewport = wrapper.get("nav");
      Object.defineProperties(viewport.element, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 2_000 },
        scrollTop: { configurable: true, writable: true, value: 1_500 },
      });
      await viewport.trigger("scroll");
      expect(wrapper.emitted("endReached")).toHaveLength(1);
      for (const loading of [true, false, true, false]) await wrapper.setProps({ loading });
      expect(wrapper.emitted("endReached")).toHaveLength(1);
      await wrapper.setProps({ retryKey: 1 });
      expect(wrapper.emitted("endReached")).toHaveLength(2);
    });

    it("paginates terminal history when the flat list reaches its end", async () => {
      const wrapper = mount(AgentInvocationList, { props: { hasMore: true, items: [item("working", "running"), item("done", "completed")] } });
      const viewport = wrapper.get("nav");
      Object.defineProperties(viewport.element, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 2_000 },
        scrollTop: { configurable: true, writable: true, value: 1_600 },
      });
      await viewport.trigger("scroll");
      expect(wrapper.emitted("endReached")).toHaveLength(1);
    });

    it("continues automatic pagination when the cursor advances without new sessions", async () => {
      const wrapper = mount(AgentInvocationList, { props: { continuationKey: "page-2", hasMore: true, items: [item("working", "running")] } });
      underfilled(wrapper);
      await wrapper.get("nav").trigger("scroll");
      expect(wrapper.emitted("endReached")).toHaveLength(1);
      for (const [index, continuationKey] of ["page-4", "page-6"].entries()) {
        await wrapper.setProps({ loading: true });
        await wrapper.setProps({ continuationKey, loading: false });
        expect(wrapper.emitted("endReached")).toHaveLength(index + 2);
      }
    });

    it("continues cursor pagination for an underfilled flat list", async () => {
      const wrapper = mount(AgentInvocationList, { props: { continuationKey: "page-2", hasMore: true, items: [item("done", "completed")], retryKey: 0 } });
      underfilled(wrapper);
      await wrapper.setProps({ continuationKey: "page-3" });
      expect(wrapper.emitted("endReached")).toHaveLength(1);
      await wrapper.setProps({ retryKey: 1 });
      expect(wrapper.emitted("endReached")).toHaveLength(2);
    });

    it.each([
      ["a running session", [item("one", "running")], []],
      ["a page arrives", [item("done", "completed")], [[item("done", "completed"), item("older", "completed")]]],
      ["every page arrives", [item("working", "running"), item("done", "completed")], [
        [item("working", "running"), item("done", "completed"), item("older", "completed")],
        [item("working", "running"), item("done", "completed"), item("older", "completed"), item("oldest", "completed")],
        [item("working", "running"), item("queued", "pending"), item("done", "completed"), item("older", "completed"), item("oldest", "completed")],
      ]],
      ["visible membership changes at the same count", [item("first", "running")], [[item("first", "completed"), item("second", "running")]]],
      ["visible sessions become terminal", [item("working", "running"), item("transitioning", "running"), item("done", "completed")], [
        [item("working", "running"), item("transitioning", "completed"), item("done", "completed")],
      ]],
    ])("asks for another page while the sessions do not fill the viewport: %s", async (_label, items, pages) => {
      const wrapper = mount(AgentInvocationList, { props: { hasMore: false, items } });
      underfilled(wrapper);
      await wrapper.setProps({ hasMore: true });
      expect(wrapper.emitted("endReached")).toHaveLength(1);
      for (const [index, page] of pages.entries()) {
        await wrapper.setProps({ items: page });
        expect(wrapper.emitted("endReached")).toHaveLength(index + 2);
      }
    });

    it("continues across underfilled pages while a cursor remains", async () => {
      const wrapper = mount(AgentInvocationList, { props: { hasMore: false, items: [item("working", "running"), item("done", "completed")] } });
      underfilled(wrapper);
      await wrapper.setProps({ hasMore: true });
      expect(wrapper.emitted("endReached")).toHaveLength(1);
      for (const [index, id] of ["older", "oldest", "done-last"].entries()) {
        await wrapper.setProps({ items: [...wrapper.props("items"), item(id, "completed")] });
        expect(wrapper.emitted("endReached")).toHaveLength(index + 2);
      }
    });
  });
});
