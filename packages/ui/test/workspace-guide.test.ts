// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { defineComponent, h, type PropType, ref } from "vue";
import {
  provideWorkspaceFileOpener,
  WorkspaceFileLink,
  WorkspaceGuide,
  WorkspaceIssues,
  WorkspaceShell,
  WorkspaceSteps,
  WorkspaceTask,
} from "../src/workspace.ts";

// Nuxt UI stand-ins: a button that keeps its label, aria-label, and disabled state, and a menu that lists its items.
type Item = { label: string, type?: string, onSelect?: () => void };
const UButton = defineComponent({
  props: { label: { default: undefined, type: String }, disabled: Boolean },
  setup: (props, { attrs, slots }) => () => h("button", {
    "aria-label": attrs["aria-label"],
    class: attrs.class,
    disabled: props.disabled,
    type: "button",
    onClick: attrs.onClick,
  }, slots.default?.() ?? props.label),
});
const UDropdownMenu = defineComponent({
  props: { items: { required: true, type: Array as PropType<Item[][]> } },
  setup: (props, { slots }) => () => h("div", { class: "menu" }, [
    slots.default?.(),
    ...props.items.flat().filter(item => item.type !== "label").map(item => h("button", { "data-item": item.label, onClick: item.onSelect }, item.label)),
  ]),
});
const global = { components: { UButton, UDropdownMenu } };

const steps = [
  { title: "Write a component" },
  { title: "Translate it", description: "One catalog per locale." },
  { title: "Plurals" },
];

describe("WorkspaceSteps", () => {
  it("shows the step, and Back and Next move one step and stop at the ends", async () => {
    const wrapper = mount(WorkspaceSteps, { global, props: { step: 0, steps, "onUpdate:step": (step: number) => wrapper.setProps({ step }) } });
    const back = () => wrapper.get("[aria-label='Previous step']");
    const next = () => wrapper.get("[aria-label='Next step']");
    expect(wrapper.get(".vh-ws-step-nav-name").text()).toBe("1. Write a component");
    expect(wrapper.get(".vh-ws-step-nav-count").text()).toBe("Step 1 of 3");
    expect(back().attributes("disabled")).toBeDefined();

    await next().trigger("click");
    await next().trigger("click");
    expect(wrapper.emitted("update:step")).toEqual([[1], [2]]);
    expect(wrapper.get(".vh-ws-step-nav-count").text()).toBe("Step 3 of 3");
    expect(next().attributes("disabled")).toBeDefined();

    await back().trigger("click");
    expect(wrapper.emitted("update:step")!.at(-1)).toEqual([1]);
  });

  it("lists every step in the menu, and a pick jumps to it", async () => {
    const wrapper = mount(WorkspaceSteps, { global, props: { label: "Translate an app", steps } });
    expect(wrapper.findAll("[data-item]").map(item => item.text())).toEqual(["1. Write a component", "2. Translate it", "3. Plurals"]);
    await wrapper.get("[data-item='3. Plurals']").trigger("click");
    // Without v-model it keeps its own step.
    expect(wrapper.emitted("update:step")).toEqual([[2]]);
    expect(wrapper.get(".vh-ws-step-nav-name").text()).toBe("3. Plurals");
    await wrapper.get("[data-item='3. Plurals']").trigger("click");
    expect(wrapper.emitted("update:step")).toHaveLength(1);
  });

  it("keeps a step out of range inside the steps", () => {
    const wrapper = mount(WorkspaceSteps, { global, props: { step: 9, steps } });
    expect(wrapper.get(".vh-ws-step-nav-count").text()).toBe("Step 3 of 3");
  });
});

describe("WorkspaceGuide", () => {
  it("shows the position, the step title, and the slot, and never touches the slot's text", () => {
    const wrapper = mount(WorkspaceGuide, { global, props: { step: 1, steps }, slots: { default: () => h("p", "**not Markdown**") } });
    expect(wrapper.get(".vh-ws-guide-kicker").text()).toBe("Step 2 of 3");
    expect(wrapper.get("h2.vh-ws-guide-title").text()).toBe("Translate it");
    expect(wrapper.get(".vh-ws-guide-content").html()).toContain("<p>**not Markdown**</p>");
  });

  it("puts Back and Next in the footer, after the text", async () => {
    const step = ref(0);
    const wrapper = mount(defineComponent({
      setup: () => () => h(WorkspaceGuide, { step: step.value, steps, "onUpdate:step": (value: number) => { step.value = value; } }, {
        default: () => h("p", "Text"),
        finish: () => h("a", { class: "finish", href: "/learn" }, "Back to Learn"),
      }),
    }), { global });
    const footer = () => wrapper.get(".vh-ws-guide-footer");
    expect(wrapper.get(".vh-ws-guide-pane").element.lastElementChild).toBe(footer().element);
    expect(footer().find(".vh-ws-guide-back").exists()).toBe(false);
    expect(footer().get(".vh-ws-guide-next").text()).toBe("Next: Translate it");

    await footer().get(".vh-ws-guide-next").trigger("click");
    expect(step.value).toBe(1);
    expect(footer().get(".vh-ws-guide-back").attributes("aria-label")).toBe("Back to step 1: Write a component");
    await footer().get(".vh-ws-guide-next").trigger("click");
    expect(step.value).toBe(2);
    // The last step shows the finish slot in place of Next.
    expect(footer().find(".vh-ws-guide-next").exists()).toBe(false);
    expect(footer().get(".finish").text()).toBe("Back to Learn");
    await footer().get(".vh-ws-guide-back").trigger("click");
    expect(step.value).toBe(1);
  });

  it("has no footer and no position with one step or none", () => {
    const one = mount(WorkspaceGuide, { global, props: { steps: [steps[0]!] } });
    expect(one.find(".vh-ws-guide-footer").exists()).toBe(false);
    expect(one.find(".vh-ws-guide-kicker").exists()).toBe(false);
    const titled = mount(WorkspaceGuide, { global, props: { title: "Read me" } });
    expect(titled.get("h2").text()).toBe("Read me");
  });

  it("shows the finish action and a page footer with one step", () => {
    const finish = mount(WorkspaceGuide, { global, props: { steps: [steps[0]!] }, slots: { finish: () => h("a", { class: "finish", href: "/learn" }, "Done") } });
    expect(finish.get(".vh-ws-guide-footer .finish").text()).toBe("Done");
    const footer = mount(WorkspaceGuide, { global, props: { steps: [steps[0]!] }, slots: { footer: () => h("p", { class: "own" }, "Own footer") } });
    expect(footer.get(".vh-ws-guide-footer .own").text()).toBe("Own footer");
  });

  it("hides the finish action while the steps are still empty", () => {
    const finish = () => h("a", { class: "finish", href: "/learn" }, "Done");
    const loading = mount(WorkspaceGuide, { global, props: { steps: [] }, slots: { finish } });
    expect(loading.find(".vh-ws-guide-footer").exists()).toBe(false);
    const footer = mount(WorkspaceGuide, { global, props: { steps: [] }, slots: { footer: () => h("p", { class: "own" }, "Own footer") } });
    expect(footer.get(".vh-ws-guide-footer .own").text()).toBe("Own footer");
  });

  it("fills the guide pane of the shell in guide-top and guide-side", () => {
    for (const layout of ["guide-top", "guide-side"] as const) {
      const wrapper = mount(WorkspaceShell, { global, props: { layout, storageKey: false }, slots: { guide: () => h(WorkspaceGuide, { steps }) } });
      expect(wrapper.find(".vh-ws-guide > .vh-ws-guide-pane").exists()).toBe(true);
    }
  });
});

describe("WorkspaceFileLink", () => {
  it("shows the file name and opens the path through the opener above it", async () => {
    const opened: string[] = [];
    const wrapper = mount(defineComponent({
      setup() {
        provideWorkspaceFileOpener({ show: path => opened.push(path) });
        return () => h(WorkspaceGuide, { steps }, () => h("p", ["Open ", h(WorkspaceFileLink, { path: "src/components/Greeting.vue" }), "."]));
      },
    }), { global });
    const link = wrapper.get(".vh-ws-file-link");
    expect(link.text()).toBe("Greeting.vue");
    expect(link.attributes("title")).toBe("Open src/components/Greeting.vue");
    await link.trigger("click");
    expect(opened).toEqual(["src/components/Greeting.vue"]);
  });

  it("emits open without an opener, and its slot replaces the name", async () => {
    const wrapper = mount(WorkspaceFileLink, { props: { path: "locales/es.json" }, slots: { default: () => "the Spanish catalog" } });
    expect(wrapper.text()).toBe("the Spanish catalog");
    await wrapper.trigger("click");
    expect(wrapper.emitted("open")).toEqual([["locales/es.json"]]);
  });
});

describe("WorkspaceTask", () => {
  it("names the box and shows its slot", () => {
    const wrapper = mount(WorkspaceTask, { slots: { default: () => "Change the text." } });
    expect(wrapper.attributes("role")).toBe("note");
    expect(wrapper.get(".vh-ws-task-title").text()).toBe("Try it");
    expect(wrapper.get(".vh-ws-task-body").text()).toBe("Change the text.");
    expect(mount(WorkspaceTask, { props: { title: "Your turn" } }).get(".vh-ws-task-title").text()).toBe("Your turn");
  });
});

describe("WorkspaceIssues", () => {
  it("lists issues with their line, and hides when there are none", async () => {
    const wrapper = mount(WorkspaceIssues, { props: { issues: [{ line: 3, message: "Missing comma." }, { message: "No title." }] } });
    expect(wrapper.attributes("aria-live")).toBe("polite");
    expect(wrapper.findAll("li").map(item => item.text())).toEqual(["Line 3Missing comma.", "No title."]);
    await wrapper.setProps({ issues: [] });
    expect(wrapper.attributes("hidden")).toBeDefined();
    await wrapper.setProps({ empty: "No issues." });
    expect(wrapper.attributes("hidden")).toBeUndefined();
    expect(wrapper.text()).toBe("No issues.");
  });
});
