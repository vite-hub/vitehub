import { renderToString } from "@vue/server-renderer";
import { createSSRApp, h } from "vue";
import { describe, expect, it } from "vitest";
import { Status } from "../src/index.ts";

const render = (props: Record<string, unknown>, slot?: () => unknown) => renderToString(createSSRApp(() => h(Status, props, slot)));

describe("Status", () => {
  it("renders a decorative dot and the label, neutral and small by default", async () => {
    const html = await render({ label: "Draft" });
    expect(html).toBe('<span data-size="sm" data-slot="status" data-tone="neutral"><span aria-hidden="true" data-slot="status-indicator"></span><span data-slot="status-label">Draft</span></span>');
  });

  it("passes the tone, size, colored label, and pulse to data attributes", async () => {
    const html = await render({ colored: true, label: "Failed", pulse: true, size: "md", tone: "error" });
    expect(html).toContain('data-colored data-size="md" data-slot="status" data-tone="error"');
    expect(html).toContain('<span aria-hidden="true" data-pulse data-slot="status-indicator"></span>');
  });

  it("renders only the dot without a label, and the slot in place of the label", async () => {
    expect(await render({ tone: "success" })).not.toContain("status-label");
    const html = await render({ tone: "success" }, () => h("span", { class: "sr-only" }, "Published"));
    expect(html).toContain('<span data-slot="status-label"><span class="sr-only">Published</span></span>');
  });
});

describe("Status styles", () => {
  it("stops the pulse under reduced motion", async () => {
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\[data-slot="status-indicator"\]\[data-pulse\]::after \{\s*animation: none;/);
  });
});
