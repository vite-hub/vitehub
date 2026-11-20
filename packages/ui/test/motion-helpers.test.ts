// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { h, nextTick, ref } from "vue";
import { MorphText, RollNumber } from "../src/components/motion.ts";
import { morphText, rollNumber, ring } from "../src/motion.ts";
import { diffDigits } from "../src/motion/helpers/number.ts";
import { diffText } from "../src/motion/helpers/text.ts";
import { cubicBezier } from "../src/motion/helpers/tween.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("diffText", () => {
  it("keeps the shared start, lets the other old letters go, and types the new ones", () => {
    expect(diffText("Publish", "Publishing")).toEqual({ kept: "Publish", gone: "", typed: "ing" });
    expect(diffText("Publishing", "Published")).toEqual({ kept: "Publish", gone: "ing", typed: "ed" });
    expect(diffText("Published", "Publish")).toEqual({ kept: "Publish", gone: "ed", typed: "" });
    expect(diffText("Copy page", "Copied")).toEqual({ kept: "Cop", gone: "y page", typed: "ied" });
    expect(diffText("Copy", "Copy")).toEqual({ kept: "Copy", gone: "", typed: "" });
    expect(diffText("", "Save")).toEqual({ kept: "", gone: "", typed: "Save" });
  });

  it("counts letters, not UTF-16 units", () => {
    expect(diffText("Done 👍", "Done 👎")).toEqual({ kept: "Done ", gone: "👍", typed: "👎" });
  });
});

describe("diffDigits", () => {
  it("lists only the columns that change, counted from the units", () => {
    expect(diffDigits("12", "13")).toEqual([{ index: 0, from: "2", to: "3" }]);
    expect(diffDigits("1,204", "1,214")).toEqual([{ index: 1, from: "0", to: "1" }]);
    expect(diffDigits("128", "128")).toEqual([]);
  });

  it("adds a column on the left when the number gets longer, and removes it when it gets shorter", () => {
    expect(diffDigits("99", "100")).toEqual([
      { index: 0, from: "9", to: "0" },
      { index: 1, from: "9", to: "0" },
      { index: 2, from: "", to: "1" },
    ]);
    expect(diffDigits("100", "99")).toEqual([
      { index: 0, from: "0", to: "9" },
      { index: 1, from: "0", to: "9" },
      { index: 2, from: "1", to: "" },
    ]);
  });
});

describe("cubicBezier", () => {
  it("follows the CSS curve, including an overshoot", () => {
    const ease = cubicBezier(0.42, 0, 1, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.3153, 3);
    const overshoot = cubicBezier(0.3, 1.5, 0.5, 1);
    expect(Math.max(...Array.from({ length: 50 }, (_, index) => overshoot(index / 50)))).toBeGreaterThan(1);
  });
});

describe("the helpers with no motion", () => {
  it("keeps the current text and count when Vue replaces the root tag", async () => {
    const tag = ref("span");
    const value = ref(2);
    const wrapper = mount(() => h("div", { "data-motion": "none" }, [
      h(MorphText, { as: tag.value, text: value.value === 2 ? "Save" : "Saved" }),
      h(RollNumber, { as: tag.value, value: value.value }),
    ]), { attachTo: document.body });
    value.value = 3;
    await nextTick();
    expect(wrapper.text()).toBe("Saved3");
    tag.value = "strong";
    await nextTick();
    expect(wrapper.findAll("strong").map(node => node.text())).toEqual(["Saved", "3"]);
    wrapper.unmount();
  });

  it("set the change at once on an element that is not on the page", () => {
    const label = document.createElement("span");
    label.textContent = "Copy";
    morphText(label, "Copied");
    expect(label.textContent).toBe("Copied");
    const count = document.createElement("span");
    rollNumber(count, 12);
    rollNumber(count, 13);
    expect(count.textContent).toBe("13");
  });

  it("set the change at once inside data-motion=\"none\", and do not ring", () => {
    document.body.innerHTML = `<div data-motion="none"><button><span id="label">Publish</span></button><span id="count">9</span></div>`;
    const label = document.querySelector<HTMLElement>("#label")!;
    morphText(label, "Publishing");
    expect(label.textContent).toBe("Publishing");
    expect(label.childNodes).toHaveLength(1);
    const count = document.querySelector<HTMLElement>("#count")!;
    rollNumber(count, 10, value => value.toLocaleString("en"));
    expect(count.textContent).toBe("10");
    const button = document.querySelector("button")!;
    ring(button);
    expect(button.style.boxShadow).toBe("");
  });
});
