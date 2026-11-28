import { readFile } from "node:fs/promises";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, h } from "vue";
import { describe, expect, it } from "vitest";
import { Status, StatusIndicator, StatusLabel } from "../src/index.ts";

// Without the `<!--[-->` fragment markers that slots add to server HTML.
const render = async (props: Record<string, unknown>, slot?: () => unknown) =>
  (await renderToString(createSSRApp(() => h(Status, props, slot)))).replaceAll(/<!--[[\]]-->/g, "");

describe("Status", () => {
  it("renders a decorative dot and the label, neutral and small by default", async () => {
    const html = await render({ label: "Draft" });
    expect(html).toBe('<span data-slot="status" data-tone="neutral" data-size="sm"><span data-slot="status-indicator" aria-hidden="true"></span><span data-slot="status-label">Draft</span></span>');
  });

  it("puts the tone, size, colored label, and pulse on the root", async () => {
    const html = await render({ colored: true, label: "Failed", pulse: true, size: "md", tone: "error" });
    expect(html).toContain('<span data-slot="status" data-tone="error" data-size="md" data-colored data-pulse>');
  });

  it("renders only the dot without a label, and the parts in its slot", async () => {
    expect(await render({ tone: "success" })).not.toContain("status-label");
    const html = await render({ tone: "success" }, () => [h(StatusIndicator), h(StatusLabel, () => h("span", { class: "sr-only" }, "Published"))]);
    expect(html).toBe('<span data-slot="status" data-tone="success" data-size="sm"><span data-slot="status-indicator" aria-hidden="true"></span><span data-slot="status-label"><span class="sr-only">Published</span></span></span>');
  });
});

describe("Status styles", () => {
  it("stops the pulse under reduced motion, in the components layer", async () => {
    const css = await readFile(new URL("../registry/status/status.css", import.meta.url), "utf8");
    expect(css.startsWith("@layer components {")).toBe(true);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\[data-slot="status"\]\[data-pulse\] \[data-slot="status-indicator"\] \{\s*animation: none;/);
  });
});
