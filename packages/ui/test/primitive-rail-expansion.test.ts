// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, nextTick } from "vue";
import { PrimitiveRail, PrimitiveRailItem, type PrimitiveRailSlotProps } from "../src/primitive-rail.ts";

function mountRail() {
  return mount(PrimitiveRail, {
    attachTo: document.body,
    props: { label: "Sections" },
    slots: {
      header: ({ expanded }: PrimitiveRailSlotProps) => h("output", { "data-open": String(expanded) }),
      default: () => [
        h(PrimitiveRailItem, { icon: "kv", label: "KV" }),
        h(PrimitiveRailItem, { icon: "queue", label: "Queue" }),
      ],
      footer: ({ expanded }: PrimitiveRailSlotProps) => h("output", { "data-open": String(expanded) }),
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("primitive rail expansion", () => {
  it("ignores a passing pointer and exposes slot state during an intentional hover", async () => {
    const rail = mountRail();
    await rail.trigger("pointerenter", { pointerType: "mouse" });
    await vi.advanceTimersByTimeAsync(50);
    expect(rail.attributes("data-expanded")).toBeUndefined();
    await rail.trigger("pointerleave");
    await vi.advanceTimersByTimeAsync(500);
    expect(rail.attributes("data-expanded")).toBeUndefined();

    await rail.trigger("pointerenter", { pointerType: "mouse" });
    await vi.advanceTimersByTimeAsync(200);
    expect(rail.attributes("data-expanded")).toBe("");
    expect(rail.findAll("output").map((slot) => slot.attributes("data-open"))).toEqual(["true", "true"]);
    await rail.trigger("pointerleave");
    expect(rail.attributes("data-expanded")).toBeUndefined();
    rail.unmount();
  });

  it("keeps touch taps and pointers without hover compact", async () => {
    const rail = mountRail();
    await rail.trigger("pointerenter", { pointerType: "touch" });
    await vi.advanceTimersByTimeAsync(200);
    expect(rail.attributes("data-expanded")).toBeUndefined();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    await rail.trigger("pointerenter", { pointerType: "mouse" });
    await vi.advanceTimersByTimeAsync(200);
    expect(rail.attributes("data-expanded")).toBeUndefined();
    rail.unmount();
  });

  it("reveals labels immediately for keyboard focus and stays open while focus moves between items", async () => {
    const rail = mountRail();
    const items = rail.findAll("button");
    for (const item of items) vi.spyOn(item.element, "matches").mockReturnValue(true);
    items[0]!.element.focus();
    await nextTick();
    expect(rail.attributes("data-expanded")).toBe("");
    items[1]!.element.focus();
    await nextTick();
    expect(rail.attributes("data-expanded")).toBe("");
    items[1]!.element.blur();
    await nextTick();
    expect(rail.attributes("data-expanded")).toBeUndefined();
    rail.unmount();
  });

  it("does not retain pointer-opened labels because a click focused an item", async () => {
    const rail = mountRail();
    const item = rail.get("button");
    vi.spyOn(item.element, "matches").mockReturnValue(false);
    await rail.trigger("pointerenter", { pointerType: "mouse" });
    await vi.advanceTimersByTimeAsync(200);
    item.element.focus();
    await nextTick();
    await rail.trigger("pointerleave");
    expect(rail.attributes("data-expanded")).toBeUndefined();
    rail.unmount();
  });

  it("lets Escape dismiss a hover overlay while focus remains outside the rail", async () => {
    const rail = mountRail();
    await rail.trigger("pointerenter", { pointerType: "mouse" });
    await vi.advanceTimersByTimeAsync(200);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    await nextTick();
    expect(rail.attributes("data-expanded")).toBeUndefined();
    expect(escape.defaultPrevented).toBe(false);
    await rail.trigger("pointerleave");
    await rail.trigger("pointerenter", { pointerType: "mouse" });
    await vi.advanceTimersByTimeAsync(200);
    expect(rail.attributes("data-expanded")).toBe("");
    rail.unmount();
  });
});
