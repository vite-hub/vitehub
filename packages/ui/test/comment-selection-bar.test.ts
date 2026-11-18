// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { TooltipProvider, TooltipRoot, TooltipTrigger } from "reka-ui";
import { defineComponent, h } from "vue";
import { CommentSelectionBar } from "../src/index.ts";

const UIcon = defineComponent({ props: { name: String }, setup: (props) => () => h("span", { "data-icon": props.name }) });
const UTooltip = defineComponent({
  setup: (_props, { slots }) => () => h("span", { "data-tooltip": "" }, [slots.default?.(), h("span", { "data-tip": "" }, slots.content?.())]),
});

describe("CommentSelectionBar", () => {
  it("shows Comment, and Suggest only when the page takes suggestions", async () => {
    const bar = mount(CommentSelectionBar, { global: { components: { UIcon } } });
    expect(bar.attributes()).toMatchObject({ "aria-label": "Selected text", "data-side": "top", "data-slot": "comment-selection-bar", role: "group" });
    const actions = () => bar.findAll("[data-slot='comment-selection-bar-action']");
    expect(actions().map((action) => [action.text(), action.attributes("aria-keyshortcuts")])).toEqual([["Comment", "C"]]);
    // Without a tooltip, the hint and the key are in the title.
    expect(actions()[0]!.attributes("title")).toBe("Comment on the selected text (C)");
    await bar.setProps({ side: "bottom", suggest: true });
    expect(bar.attributes("data-side")).toBe("bottom");
    expect(actions().map((action) => [action.text(), action.attributes("aria-keyshortcuts"), action.attributes("data-action")])).toEqual([
      ["Comment", "C", "comment"],
      ["Suggest", "E", "suggest"],
    ]);
  });

  it("emits the action that was clicked", async () => {
    const bar = mount(CommentSelectionBar, { global: { components: { UIcon } }, props: { suggest: true } });
    await bar.find("[data-action='suggest']").trigger("click");
    await bar.find("[data-action='comment']").trigger("click");
    expect(Object.keys(bar.emitted()).filter((name) => name === "comment" || name === "suggest")).toEqual(["suggest", "comment"]);
    expect(bar.emitted("comment")).toHaveLength(1);
    expect(bar.emitted("suggest")).toHaveLength(1);
  });

  it("keeps the page's selection on a press", () => {
    const bar = mount(CommentSelectionBar, { global: { components: { UIcon } } });
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    bar.find("[data-action='comment']").element.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it("puts the hint and the key in a tooltip when the app has one", () => {
    const bar = mount(CommentSelectionBar, { global: { components: { UIcon, UTooltip } }, props: { suggest: true } });
    expect(bar.findAll("[data-tip]").map((tip) => tip.text())).toEqual(["Comment on the selected textC", "Suggest new wordsE"]);
    expect(bar.findAll("[data-slot='comment-selection-bar-kbd']").map((key) => key.text())).toEqual(["C", "E"]);
    expect(bar.find("[data-action='comment']").attributes("title")).toBeUndefined();
  });

  // Nuxt UI's tooltip is reka-ui's TooltipRoot, which throws without the TooltipProvider that UApp gives.
  const RekaTooltip = defineComponent({
    setup: (_props, { slots }) => () => h(TooltipRoot, null, () => h(TooltipTrigger, { asChild: true }, () => slots.default?.())),
  });

  it("shows both actions with their titles when a registered tooltip has no provider", async () => {
    const bar = mount(CommentSelectionBar, { global: { components: { UIcon, UTooltip: RekaTooltip } }, props: { suggest: true } });
    await bar.vm.$nextTick();
    expect(bar.findAll("[data-slot='comment-selection-bar-action']").map((action) => [action.text(), action.attributes("title")])).toEqual([
      ["Comment", "Comment on the selected text (C)"],
      ["Suggest", "Suggest new words (E)"],
    ]);
    await bar.find("[data-action='suggest']").trigger("click");
    expect(bar.emitted("suggest")).toHaveLength(1);
  });

  it("uses the registered tooltip inside its provider", async () => {
    const bar = mount(() => h(TooltipProvider, null, () => h(CommentSelectionBar)), { global: { components: { UIcon, UTooltip: RekaTooltip } } });
    await bar.vm.$nextTick();
    const action = bar.find("[data-action='comment']");
    expect(action.attributes("title")).toBeUndefined();
    expect(action.attributes("data-state")).toBe("closed");
  });
});
