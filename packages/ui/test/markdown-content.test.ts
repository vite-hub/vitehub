import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { defineContent } from "@vite-hub/content";
import { Markdown } from "../src/components/markdown.ts";
import { createViteHubUI } from "../src/config.ts";

async function page() {
  const markdown = "# Ready\n\n> [!NOTE]\n> No renderer setup.\n\n::steps\n### First\nRead the page.\n### Next\nKeep going.\n::\n\nInline $x^2$.\n";
  const content = defineContent({
    source: { keys: () => ["index.md"], getItem: () => markdown, getItemRaw: () => markdown },
  });
  try {
    const page = await content.get("/");
    if (!page) throw new Error("Content did not return the page");
    return page;
  } finally {
    await content.dispose();
  }
}

describe("Markdown with Content", () => {
  it.each([undefined, false])("respects the app's motion setting (%s) for string and Content values", async (motion) => {
    const MotionRuntime = defineComponent({ setup: () => () => h("span", { "data-motion-runtime": "" }) });
    for (const value of ["# Ready", await page()]) {
      const app = createSSRApp({ render: () => h(Markdown, { value, components: { MotionRuntime } }) });
      if (motion === false) app.use(createViteHubUI({ motion }));
      const html = await renderToString(app);
      expect(html).toContain("Ready</h1>");
      expect(html.includes("data-motion-runtime")).toBe(motion !== false);
    }
  });

  it("renders a Content page with its components and styles without reparsing", async () => {
    const value = await page();
    const html = await renderToString(createSSRApp({ render: () => h(Markdown, {
      value,
      plugins: [{ name: "must-not-parse", pre() { throw new Error("A Content page must not be parsed again"); } }],
    }) }));
    expect(html).toContain("No renderer setup.");
    expect(html).toContain('class="cgc');
    expect(html).toContain('class="cs');
    expect(html).toContain("data-comark-typeset");
    expect(html).toContain("<math");
    expect(html).not.toContain("vh-math-fallback");
  });

  it("includes Comark UI for string values too", async () => {
    const html = await renderToString(createSSRApp({ render: () => h(Markdown, { value: "> [!TIP]\n> Defaults are ready." }) }));
    expect(html).toContain('class="cgc');
    expect(html).toContain("Defaults are ready.");
    expect(html).toContain("data-comark-typeset");
  });

  it("lets an application override one renderer on a parsed page", async () => {
    const value = await page();
    const html = await renderToString(createSSRApp({ render: () => h(Markdown, {
      value,
      components: { "github-callout": defineComponent({ setup: () => () => h("aside", "Application callout") }) },
    }) }));
    expect(html).toContain("Application callout</aside>");
    expect(html).not.toContain("No renderer setup.");
    expect(html).toContain("Read the page.");
    expect(html).toContain("data-comark-typeset");
  });
});
