// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, type PropType } from "vue";
import { render } from "../src/workspace/runners/render.ts";
import type { WorkspaceExample } from "../src/workspace/workspace-examples.ts";
import { Workspace, type WorkspaceSlotProps } from "../src/workspace/workspace.ts";

const UButton = defineComponent({
  props: { label: { default: undefined, type: String } },
  setup: (props, { attrs, slots }) => () => h("button", { "aria-label": attrs["aria-label"], type: "button", onClick: attrs.onClick }, slots.default?.() ?? props.label),
});
type Item = { label: string, type?: string, onSelect?: () => void };
const UDropdownMenu = defineComponent({
  props: { items: { required: true, type: Array as PropType<Item[][]> } },
  setup: (props, { slots }) => () => h("div", { class: "menu" }, [
    slots.default?.(),
    ...props.items.flat().filter(item => item.type !== "label").map(item => h("button", { "data-item": item.label, onClick: item.onSelect }, item.label)),
  ]),
});
type Tab = { label: string, value: string, badge?: string | number };
const UTabs = defineComponent({
  props: { items: { required: true, type: Array as PropType<Tab[]> }, modelValue: { default: undefined, type: String } },
  setup: props => () => h("div", { role: "tablist" }, props.items.map(item => h("button", { role: "tab", type: "button" }, [item.label, item.badge === undefined ? null : ` ${item.badge}`]))),
});
const UModal = defineComponent({
  props: { open: Boolean, title: { default: undefined, type: String } },
  setup: (props, { slots }) => () => props.open ? h("div", { role: "dialog" }, [h("h2", props.title), slots.footer?.()]) : null,
});
const UIcon = defineComponent(() => () => h("i"));
const global = { components: { UButton, UDropdownMenu, UIcon, UModal, UTabs }, stubs: { WorkspaceEditor: true, WorkspaceFileTree: true } };

const plurals: WorkspaceExample = { id: "plurals", label: "Plurals", files: { "messages.json": "{\"one\":\"1 item\"}" } };
const fallbacks: WorkspaceExample = { id: "fallbacks", label: "Fallbacks", files: { "messages.json": "{\"fallback\":\"en\"}" } };

function viewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(/([\d.]+)rem/.exec(query)![1]) * 16,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function spy() {
  const box: { context?: WorkspaceSlotProps } = {};
  return { box, slot: (props: WorkspaceSlotProps) => { box.context = props; return []; } };
}

beforeEach(() => {
  history.replaceState(null, "", "/render");
  viewport(1440);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Workspace with render()", () => {
  it("renders the files into a sandboxed frame, with the issues in their own tab", async () => {
    const fn = vi.fn(async (files: Record<string, string>) => ({
      html: `<p>${files["messages.json"]}</p>`,
      issues: [{ message: "The file has one key.", line: 1 }],
    }));
    const wrapper = mount(Workspace, { global, props: { examples: [plurals, fallbacks], runner: render(fn, { document: html => `<main>${html}</main>` }) } });
    await flushPromises();
    expect(fn).toHaveBeenCalledWith(plurals.files);
    const frame = wrapper.get("iframe.vh-workspace-frame");
    expect(frame.attributes("sandbox")).toBe("allow-scripts allow-popups");
    expect(frame.attributes("srcdoc")).toContain("<main><p>{\"one\":\"1 item\"}</p>");
    expect(frame.attributes("srcdoc")).toContain("vhWorkspaceScroll");
    expect(wrapper.findAll("[role='tab']").map(tab => tab.text())).toEqual(["Output", "Issues 1"]);
    expect(wrapper.get("[data-tab='issues']").text()).toContain("The file has one key.");
    expect(wrapper.get(".vh-workspace-run-state").text()).toBe("1 issue");
    expect(wrapper.find("[aria-label='More actions']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders 200 ms after the last edit, and drops a result for older files", async () => {
    const resolvers: ((html: string) => void)[] = [];
    const fn = vi.fn((_files: Record<string, string>) => new Promise<{ html: string }>((resolve) => {
      resolvers.push(html => resolve({ html }));
    }));
    const { box, slot } = spy();
    const wrapper = mount(Workspace, { global, props: { examples: [plurals], runner: render(fn) }, slots: { "bar-lead": slot } });
    await flushPromises();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    await box.context!.setFile("messages.json", "a");
    await box.context!.setFile("messages.json", "ab");
    vi.advanceTimersByTime(199);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith({ "messages.json": "ab" });
    resolvers[1]!("new");
    await flushPromises();
    resolvers[0]!("old");
    await flushPromises();
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("<body>new");
    expect(box.context!.edited).toEqual(["messages.json"]);
    wrapper.unmount();
  });

  it("shows a thrown error as an issue", async () => {
    const wrapper = mount(Workspace, { global, props: { examples: [plurals], runner: render(async () => { throw new Error("Unexpected token"); }) } });
    await flushPromises();
    expect(wrapper.get("[data-tab='issues']").text()).toContain("Unexpected token");
    expect(wrapper.get(".vh-workspace-run-state").text()).toBe("1 issue");
    wrapper.unmount();
  });

  it("opens another example in place and runs on a phone", async () => {
    viewport(390);
    const fn = vi.fn(async (files: Record<string, string>) => ({ html: files["messages.json"]! }));
    const wrapper = mount(Workspace, { global, props: { examples: [plurals, fallbacks], runner: render(fn) } });
    await flushPromises();
    expect(wrapper.find(".vh-workspace-gate").exists()).toBe(false);
    await wrapper.get("[data-item='Fallbacks']").trigger("click");
    await flushPromises();
    expect(fn).toHaveBeenLastCalledWith(fallbacks.files);
    expect(wrapper.emitted("update:example")).toEqual([["fallbacks"]]);
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("fallback");
    wrapper.unmount();
  });
});
