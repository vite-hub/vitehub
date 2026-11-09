// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSession } from "../src/agent-session.ts";

const surfaces = [
  { id: "workspace", label: "Workspace", icon: "i-lucide-files" },
  { id: "trace", label: "Trace", icon: "i-lucide-list" },
];
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

function session(props: Partial<InstanceType<typeof AgentSession>["$props"]> = {}) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  return mount(AgentSession, { props: { title: "Session", surfaces, ...props }, global: { stubs: { UIcon: true } } });
}

it("holds a controlled panel closed until the parent accepts the update", async () => {
  const wrapper = session({ panelOpen: false });
  await wrapper.get("[data-slot='agent-session-panel-toggle']").trigger("click");
  expect(wrapper.emitted("update:panelOpen")).toEqual([[true]]);
  expect(wrapper.find("[data-slot='agent-session-panel']").exists()).toBe(false);
  await wrapper.setProps({ panelOpen: true });
  expect(wrapper.find("[data-slot='agent-session-panel']").exists()).toBe(true);
  expect(wrapper.emitted("update:panelOpen")).toEqual([[true]]);
  await wrapper.get("[data-slot='agent-session-panel-toggle']").trigger("click");
  expect(wrapper.emitted("update:panelOpen")).toEqual([[true], [false]]);
  expect(wrapper.emitted("update:maximized")).toBeUndefined();
  expect(wrapper.find("[data-slot='agent-session-panel']").exists()).toBe(true);
  wrapper.unmount();
});

it("holds a controlled surface and maximization until the parent accepts them", async () => {
  const wrapper = session({ panelOpen: true, surface: "workspace", maximized: false });
  await wrapper.get("[aria-label='Open a surface']").trigger("click");
  expect(wrapper.emitted("update:surface")).toEqual([[null]]);
  expect(wrapper.get("[role='tab'][aria-selected='true']").text()).toBe("Workspace");
  await wrapper.get("[aria-label='Maximize panel']").trigger("click");
  expect(wrapper.emitted("update:maximized")).toEqual([[true]]);
  expect(wrapper.attributes("data-maximized")).toBeUndefined();
  await wrapper.setProps({ surface: "trace", maximized: true });
  expect(wrapper.get("[role='tab'][aria-selected='true']").text()).toBe("Trace");
  expect(wrapper.attributes("data-maximized")).toBe("");
  await wrapper.get("[aria-label='Close Trace']").trigger("click");
  expect(wrapper.get("[role='tab'][aria-selected='true']").text()).toBe("Trace");
  expect(wrapper.emitted("update:surface")).toEqual([[null], ["workspace"]]);
  await wrapper.setProps({ surface: "workspace" });
  expect(wrapper.find("[aria-label='Close Trace']").exists()).toBe(false);
  wrapper.unmount();
});

it("offers a close button only when the panel has more than one tab", async () => {
  const wrapper = session({ panelOpen: true, surface: "workspace" });
  expect(wrapper.findAll("[role='tab']")).toHaveLength(1);
  expect(wrapper.find("[aria-label='Close Workspace']").exists()).toBe(false);
  await wrapper.setProps({ surface: "trace" });
  expect(wrapper.findAll("[role='tab']")).toHaveLength(2);
  expect(wrapper.find("[aria-label='Close Workspace']").exists()).toBe(true);
  expect(wrapper.find("[aria-label='Close Trace']").exists()).toBe(true);
  wrapper.unmount();
});

it("keeps uncontrolled user changes in stored layout", async () => {
  let wrapper = session({ storageKey: "session-layout", defaultSurface: "workspace" });
  await wrapper.get("[data-slot='agent-session-panel-toggle']").trigger("click");
  await wrapper.get("[aria-label='Maximize panel']").trigger("click");
  wrapper.unmount();
  wrapper = session({ storageKey: "session-layout" });
  expect(wrapper.find("[data-slot='agent-session-panel']").exists()).toBe(true);
  expect(wrapper.attributes("data-maximized")).toBe("");
  expect(wrapper.get("[role='tab'][aria-selected='true']").text()).toBe("Workspace");
  wrapper.unmount();
});
