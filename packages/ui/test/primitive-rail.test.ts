import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { PrimitiveIcon, PrimitiveRail, PrimitiveRailGroup, PrimitiveRailItem, primitiveIconNames } from "../src/primitive-rail.ts";

const render = (component: () => ReturnType<typeof h>) => renderToString(createSSRApp({ render: component }));

describe("primitive rail", () => {
  it("draws a distinct square icon for every name", async () => {
    const icons = await Promise.all(primitiveIconNames.map((name) => render(() => h(PrimitiveIcon, { name }))));
    for (const icon of icons) {
      expect(icon).toContain('viewBox="0 0 24 24"');
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).toContain('stroke="currentColor"');
    }
    const drawings = icons.map((icon) => icon.replace(/ data-icon="[^"]+"/, ""));
    expect(new Set(drawings).size).toBe(primitiveIconNames.length);
  });

  it("names the landmark and every icon-only target", async () => {
    const link = defineComponent({
      props: { to: { required: true, type: String } },
      setup: (props, { slots }) => () => h("a", { href: props.to }, slots.default?.()),
    });
    const html = await render(() => h(PrimitiveRail, { label: "Docs sections" }, {
      default: () => [
        h(PrimitiveRailGroup, () => [
          h(PrimitiveRailItem, { as: link, current: true, icon: "kv", label: "KV", to: "/docs/kv" }),
          h(PrimitiveRailItem, { as: link, icon: "queue", label: "Queue", to: "/docs/queue" }),
        ]),
      ],
      footer: () => [h(PrimitiveRailItem, { label: "Retry" }, () => h("i", "retry"))],
    }));
    const root = new Window().document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelector('nav[aria-label="Docs sections"]')).not.toBeNull();
    const kv = root.querySelector('a[href="/docs/kv"]');
    expect(kv?.getAttribute("aria-current")).toBe("page");
    expect(kv?.getAttribute("aria-label")).toBe("KV");
    expect(kv?.querySelector("svg")?.getAttribute("data-icon")).toBe("kv");
    expect(kv?.querySelector(".vh-primitive-rail__label")?.textContent).toBe("KV");
    expect(root.querySelector('a[href="/docs/queue"]')?.getAttribute("aria-label")).toBe("Queue");
    // A plain item is a button that does not submit a surrounding form, and its slot replaces the icon.
    const retry = root.querySelector('button[aria-label="Retry"]');
    expect(retry?.getAttribute("type")).toBe("button");
    expect(retry?.querySelector("i")?.textContent).toBe("retry");
    expect(retry?.querySelector("svg")).toBeNull();
    expect(retry?.querySelector(".vh-primitive-rail__label")?.textContent).toBe("Retry");
  });
});
