// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { PrimitiveRail, PrimitiveRailItem } from "../src/primitive-rail.ts";

const itemHeight = 36;
const bodyHeight = 100;

afterEach(() => { vi.restoreAllMocks(); });

describe("primitive rail scrolling", () => {
  it("shows the current item on mount and after a change without scrolling the page", async () => {
    // Lay the rail out as a 100px viewport over a column of 36px items.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("vh-primitive-rail__body")) return DOMRect.fromRect({ height: bodyHeight, width: 56, x: 0, y: 0 });
      const body = this.closest(".vh-primitive-rail__body");
      const top = Number(this.dataset.index) * itemHeight - (body?.scrollTop ?? 0);
      return DOMRect.fromRect({ height: itemHeight, width: 36, x: 0, y: top });
    });
    const scrollTo = vi.spyOn(window, "scrollTo");
    const current = ref(8);
    const Rail = defineComponent({
      setup: () => () => h(PrimitiveRail, { label: "Sections" }, () =>
        Array.from({ length: 10 }, (_, index) => h(PrimitiveRailItem, {
          current: index === current.value,
          "data-index": index,
          icon: "kv",
          label: `Section ${index}`,
        }))),
    });
    const wrapper = mount(Rail, { attachTo: document.body });
    const body = wrapper.get(".vh-primitive-rail__body").element;

    // Item 8 spans 288 to 324, so the body scrolls until its bottom edge is visible.
    expect(body.scrollTop).toBe(8 * itemHeight + itemHeight - bodyHeight);

    current.value = 1;
    await nextTick();
    expect(body.scrollTop).toBe(itemHeight);

    // An item that is already visible does not move the rail.
    current.value = 2;
    await nextTick();
    expect(body.scrollTop).toBe(itemHeight);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(window.scrollY).toBe(0);
    wrapper.unmount();
  });
});
