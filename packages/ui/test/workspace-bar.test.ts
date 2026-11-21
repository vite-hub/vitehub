// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, type PropType } from "vue";
import { groupExamples, WorkspaceBar, type WorkspaceExample, WorkspaceExamples, WorkspaceSidebar, WorkspaceStart } from "../src/workspace.ts";

// Nuxt UI stand-ins: a button, a menu that lists its items as buttons, and an icon.
type Item = { label: string, type?: string, checked?: boolean, description?: string, onSelect?: () => void };
const UButton = defineComponent({
  props: { label: { default: undefined, type: String } },
  setup: (props, { attrs, slots }) => () => h("button", { ...attrs, type: "button" }, slots.default?.() ?? props.label),
});
const UDropdownMenu = defineComponent({
  props: { items: { required: true, type: Array as PropType<Item[][]> } },
  setup: (props, { slots }) => () => h("div", { class: "menu" }, [
    slots.default?.(),
    ...props.items.map(group => h("div", { role: "group" }, group.map(item => item.type === "label"
      ? h("h4", item.label)
      : h("button", { "aria-checked": String(!!item.checked), "data-item": item.label, role: "menuitemcheckbox", onClick: item.onSelect }, [item.label, item.description ? h("small", item.description) : null])))),
  ]),
});
const UIcon = defineComponent(() => () => h("i"));
const global = { components: { UButton, UDropdownMenu, UIcon } };

const examples: WorkspaceExample[] = [
  { description: "A greeting.", group: "Source language", id: "vue", label: "Vue", files: { "a.ts": "", "b.ts": "" } },
  { id: "empty", label: "Empty", files: { "package.json": "{}" } },
  { group: "Recipes", id: "plurals", label: "Plurals" },
  { group: "Source language", id: "react", label: "React" },
];

afterEach(() => { document.body.innerHTML = ""; });

describe("groupExamples", () => {
  it("puts examples without a group first, then each group in the order of its first example", () => {
    expect(groupExamples(examples).map(({ group, examples }) => [group, examples.map(example => example.id)])).toEqual([
      [undefined, ["empty"]],
      ["Source language", ["vue", "react"]],
      ["Recipes", ["plurals"]],
    ]);
  });
});

describe("WorkspaceBar", () => {
  it("shows the sidebar button only when `sidebar` is set, and puts the slots in order", async () => {
    const plain = mount(WorkspaceBar, { global, slots: { actions: () => h("b", "actions") } });
    expect(plain.find("[aria-controls]").exists()).toBe(false);

    const bar = mount(WorkspaceBar, {
      global,
      props: { sidebar: false, sidebarId: "side", step: "Step 2 of 5" },
      slots: { lead: () => h("b", "lead"), examples: () => h("b", "examples"), default: () => h("b", "state"), actions: () => h("b", "actions") },
    });
    const toggle = bar.get("[aria-controls='side']");
    expect(toggle.attributes()).toMatchObject({ "aria-expanded": "false", "aria-label": "Open the sidebar" });
    expect(bar.get("header").element.children[0]).toBe(toggle.element);
    expect(bar.text()).toBe("leadexamplesStep 2 of 5stateactions");
    expect(bar.find(".vh-ws-spacer + b").text()).toBe("actions");
    await toggle.trigger("click");
    expect(bar.emitted("update:sidebar")).toEqual([[true]]);
    await bar.setProps({ sidebar: true });
    expect(toggle.attributes()).toMatchObject({ "aria-expanded": "true", "aria-label": "Close the sidebar" });
  });
});

describe("WorkspaceExamples", () => {
  it("lists the examples under their groups, checks the open one, and emits only a change", async () => {
    const menu = mount(WorkspaceExamples, { global, props: { examples, modelValue: "react" } });
    expect(menu.get("button").attributes("aria-label")).toBe("Example: React");
    expect(menu.findAll("h4").map(heading => heading.text())).toEqual(["Source language", "Recipes"]);
    expect(menu.findAll("[role='menuitemcheckbox']").map(item => [item.attributes("data-item"), item.attributes("aria-checked")])).toEqual([
      ["Empty", "false"], ["Vue", "false"], ["React", "true"], ["Plurals", "false"],
    ]);
    expect(menu.get("[data-item='Vue'] small").text()).toBe("A greeting.");
    await menu.get("[data-item='React']").trigger("click");
    expect(menu.emitted("update:modelValue")).toBeUndefined();
    await menu.get("[data-item='Plurals']").trigger("click");
    expect(menu.emitted("update:modelValue")).toEqual([["plurals"]]);
  });

  it("shows the first example when the model is not set", () => {
    const menu = mount(WorkspaceExamples, { global, props: { examples, label: "Template" } });
    expect(menu.get("button").attributes("aria-label")).toBe("Template: Vue");
  });
});

describe("WorkspaceSidebar", () => {
  function setup() {
    const toggle = document.createElement("button");
    toggle.setAttribute("aria-controls", "side");
    const outside = document.createElement("p");
    document.body.append(toggle, outside);
    toggle.focus();
    const sidebar = mount(WorkspaceSidebar, {
      attachTo: document.body,
      global,
      props: { id: "side" },
      slots: { default: () => h("a", { href: "#intro" }, "Introduction") },
    });
    return { outside, sidebar, toggle };
  }

  it("is inert when closed, moves focus in when it opens, and back to the button on Escape", async () => {
    const { sidebar, toggle } = setup();
    expect(sidebar.get("aside").attributes()).toMatchObject({ "aria-label": "Sidebar", id: "side" });
    expect((sidebar.get("aside").element as HTMLElement).inert).toBe(true);
    await sidebar.setProps({ open: true });
    await nextTick();
    expect(document.activeElement?.textContent).toBe("Introduction");
    await sidebar.get("aside").trigger("keydown", { key: "Escape" });
    expect(sidebar.emitted("update:open")).toEqual([[false]]);
    await sidebar.setProps({ open: false });
    expect(document.activeElement).toBe(toggle);
    sidebar.unmount();
  });

  it("closes on a pointer down outside, but not on the panel or its button", async () => {
    const { outside, sidebar, toggle } = setup();
    await sidebar.setProps({ open: true });
    sidebar.get("a").element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    toggle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    expect(sidebar.emitted("update:open")).toBeUndefined();
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    expect(sidebar.emitted("update:open")).toEqual([[false]]);
    sidebar.unmount();
  });

  it("puts Reset, Download, and Copy link at the bottom and emits them", async () => {
    const sidebar = mount(WorkspaceSidebar, { global, props: { open: true } });
    const buttons = sidebar.findAll(".vh-ws-sidebar-footer button");
    expect(buttons.map(button => button.text())).toEqual(["Reset", "Download", "Copy link"]);
    for (const button of buttons) await button.trigger("click");
    expect(Object.keys(sidebar.emitted()).filter(name => ["reset", "download", "copy-link"].includes(name))).toEqual(["reset", "download", "copy-link"]);
    await sidebar.setProps({ actions: ["copy-link"], copied: true });
    expect(sidebar.findAll(".vh-ws-sidebar-footer button").map(button => button.text())).toEqual(["Link copied"]);
    await sidebar.setProps({ actions: [] });
    expect(sidebar.find(".vh-ws-sidebar-footer").exists()).toBe(false);
  });
});

describe("WorkspaceStart", () => {
  it("shows a card per example with its file count, and emits the pick", async () => {
    const start = mount(WorkspaceStart, { global, props: { examples } });
    expect(start.get("section").attributes("aria-labelledby")).toBe(start.get("h2").attributes("id"));
    expect(start.get("h2").text()).toBe("Start from an example");
    expect(start.findAll(".vh-ws-start-card").map(card => card.text())).toEqual(["VueA greeting.2 files", "Empty1 file", "Plurals", "React"]);
    await start.findAll(".vh-ws-start-card")[2]!.trigger("click");
    expect(start.emitted("pick")).toEqual([["plurals"]]);
    expect(start.get(".vh-ws-start-foot").text()).toContain("Opened from a share link?");
  });
});
