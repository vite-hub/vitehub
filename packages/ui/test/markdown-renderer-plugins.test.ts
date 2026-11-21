import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "../src/components/markdown-renderer.ts";

describe("MarkdownRenderer plugins", () => {
  it("rejects a plugin named html instead of dropping it", async () => {
    const html = { name: "html" };
    const render = renderToString(createSSRApp({ render: () => h(MarkdownRenderer, { value: "<b>hi</b>", plugins: [html] }) }));
    await expect(render).rejects.toMatchObject({ code: "UI_R0002" });
  });
});
