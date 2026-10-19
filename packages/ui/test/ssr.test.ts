import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { AgentChat } from "../src/components/agent-chat.ts";
import { AgentMarkdown } from "../src/components/agent-markdown.ts";
import html from "@comark/vue/plugins/html";
import type { ComarkPlugin } from "@comark/vue";
import { createViteHubUI } from "../src/config.ts";

describe("UI server rendering", () => {
  it("renders retained Markdown images as accessible previews and permits custom images", async () => {
    const value = "![chart.png](/files/retained-image)";
    const app = createSSRApp({ render: () => h(AgentMarkdown, { value }) });
    app.use(createViteHubUI());
    const html = await renderToString(app);
    expect(html).toContain('aria-label="Preview chart.png"');
    expect(html).toContain('src="/files/retained-image"');
    expect(html).toContain('alt="chart.png"');
    expect(html).not.toContain('role="dialog"');

    const custom = createSSRApp({ render: () => h(AgentMarkdown, {
      components: { img: defineComponent({ setup: () => () => h("span", "Custom image") }) },
      value,
    }) });
    expect(await renderToString(custom)).toContain("Custom image");
  });

  it("composes custom Markdown plugins with built-in math support", async () => {
    let customPluginRuns = 0;
    const app = createSSRApp({
      render: () => h(AgentMarkdown, {
        plugins: [{
          name: "custom",
          markdownItPlugins: [() => { customPluginRuns++; }],
        }],
        value: "Inline $x$",
      }),
    });

    const html = await renderToString(app);
    expect(customPluginRuns).toBe(1);
    expect(html).toContain("vh-math-fallback");
  });

  it.each(["task-list", "components", "attributes", "alert", "frontmatter"])("replaces the %s Markdown default with the caller's plugin", async (name) => {
    const plugin: ComarkPlugin = {
      name,
      pre(state) {
        state.markdown = state.markdown.replace("Original", "Overridden");
      },
    };
    const app = createSSRApp({
      render: () => h(AgentMarkdown, {
        plugins: [plugin],
        value: "Original\n\nInline $x$",
      }),
    });

    const output = await renderToString(app);
    expect(output).toContain("Overridden");
    expect(output).not.toContain("Original");
    expect(output).toContain("vh-math-fallback");
  });

  it("does not render raw HTML from Agent messages", async () => {
    const app = createSSRApp({
      render: () => h(AgentMarkdown, {
        value: '<script>globalThis.__vitehubXss = true</script>\n\n<div onmouseover="globalThis.__vitehubXss = true">message</div>',
      }),
    });

    const html = await renderToString(app);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('onmouseover="');
    expect(html).toContain("message");
  });

  it("keeps raw HTML disabled when callers request the HTML plugin", async () => {
    const app = createSSRApp({
      render: () => h(AgentMarkdown, {
        options: { html: true },
        plugins: [html()],
        value: '<script>globalThis.__vitehubXss = true</script>message',
      }),
    });

    const output = await renderToString(app);
    expect(output).not.toContain("<script>");
    expect(output).toContain("message");
  });

  it("preserves non-HTML Markdown defaults", async () => {
    const app = createSSRApp({
      render: () => h(AgentMarkdown, { value: "- [x] completed" }),
    });

    const html = await renderToString(app);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("completed");
  });

  it("renders runtime Nuxt UI components through the Vue plugin", async () => {
    const app = createSSRApp({
      render: () =>
        h(AgentChat, {
          messages: [
            { id: "user-1", parts: [{ text: "Inspect the failing check", type: "text" }], role: "user" },
          ],
        }),
    });

    app.use(createViteHubUI());

    for (const name of [
      "UBadge",
      "UButton",
      "UChatMessage",
      "UChatPrompt",
      "UChatPromptSubmit",
      "UChatReasoning",
      "UChatTool",
      "UCollapsible",
      "UIcon",
    ]) {
      expect(app.component(name), name).toBeDefined();
    }

    const html = await renderToString(app);
    expect(html).toContain("Inspect the failing check");
    expect(html).toContain('data-role="user"');
  });

  it("renders AI SDK messages without browser globals", async () => {
    const app = createSSRApp({
      render: () =>
        h(AgentChat, {
          messages: [
            { id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" },
            {
              id: "assistant-1",
              parts: [{ text: "**Hello** back", type: "text" }],
              role: "assistant",
            },
          ],
        }),
    });
    app.component(
      "UChatMessage",
      defineComponent({
        props: ["id", "parts", "role"],
        setup(_props, { slots }) {
          return () => h("article", slots.body?.() ?? slots.content?.());
        },
      }),
    );
    const html = await renderToString(app);
    expect(html).toContain('data-message-id="assistant-1"');
    expect(html).toContain("<strong>Hello</strong>");
  });
});
