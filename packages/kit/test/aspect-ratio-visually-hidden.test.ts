// @vitest-environment happy-dom
import { h, ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { AspectRatio } from "@vite-hub/kit/aspect-ratio";
import { VisuallyHidden } from "@vite-hub/kit/visually-hidden";

import { mount, one, settle } from "./dom.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("AspectRatio", () => {
  it("keeps the ratio it gets, and follows a new one", async () => {
    const ratio = ref(16 / 9);
    const view = mount(() => h(AspectRatio, { ratio: ratio.value, style: { width: "320px" } }, () => h("img", { alt: "" })));
    cleanup = view.unmount;
    const root = one(view.host, '[data-slot="aspect-ratio"]');
    // Browsers write a lone number as `<number> / 1`.
    expect(root.style.getPropertyValue("aspect-ratio")).toMatch(/^1\.7777\d* \/ 1$/);
    expect(root.style.getPropertyValue("--aspect-ratio")).toBe(String(16 / 9));
    expect(root.style.width).toBe("320px");
    ratio.value = 1;
    await settle();
    expect(root.style.getPropertyValue("aspect-ratio")).toBe("1 / 1");
  });
});

describe("VisuallyHidden", () => {
  it("hides its content from sight, not from screen readers", () => {
    const view = mount(() => h("button", null, ["x", h(VisuallyHidden, null, () => "Close")]));
    cleanup = view.unmount;
    const hidden = one(view.host, '[data-slot="visually-hidden"]');
    expect(hidden.tagName).toBe("SPAN");
    expect(hidden.textContent).toBe("Close");
    expect(hidden.style.position).toBe("absolute");
    expect(hidden.style.width).toBe("1px");
    expect(hidden.style.getPropertyValue("clip-path")).toBe("inset(50%)");
    expect(hidden.hasAttribute("aria-hidden")).toBe(false);
    expect(hidden.hasAttribute("tabindex")).toBe(false);
  });

  it("hides its content from screen readers too when fully hidden", () => {
    const view = mount(() => h(VisuallyHidden, { feature: "fully-hidden" }, () => h("input", { name: "token" })));
    cleanup = view.unmount;
    const hidden = one(view.host, '[data-slot="visually-hidden"]');
    expect(hidden.getAttribute("aria-hidden")).toBe("true");
    expect(hidden.getAttribute("tabindex")).toBe("-1");
    expect(hidden.hasAttribute("data-hidden")).toBe(true);
  });
});
