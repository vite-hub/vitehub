// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, defineComponent, h } from "vue";
import { describe, expect, it, vi } from "vitest";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
  useHighlightedCode,
} from "../src/index.ts";

const ButtonStub = defineComponent({
  setup(_props, { attrs }) {
    return () => h("button", { ...attrs, "data-stub": "UButton" });
  },
});

describe("CodeBlock", () => {
  it("renders the shadcn/ui slots, variant, and size", () => {
    const wrapper = mount(() =>
      h(CodeBlock, { size: "sm", variant: "destructive" }, () => [
        h(CodeBlockHeader, () => [h(CodeBlockTitle, () => "stderr"), h(CodeBlockActions)]),
        h(CodeBlockContent, { wrap: true }, () => "Error: missing lockfile"),
      ]),
    );

    expect(wrapper.get("[data-slot=code-block]").attributes()).toMatchObject({ "data-size": "sm", "data-variant": "destructive" });
    const content = wrapper.get("[data-slot=code-block-content]");
    expect(content.element.tagName).toBe("PRE");
    expect(content.attributes()).toMatchObject({ "data-wrap": "", dir: "ltr", tabindex: "0" });
    expect(content.get("code[data-slot=code-block-code]").text()).toBe("Error: missing lockfile");
  });

  it("splits plain text into numbered lines from the start line", () => {
    const wrapper = mount(() => h(CodeBlockContent, { lineNumbers: true, startLine: 41 }, () => "one\n\nthree\n"));

    const content = wrapper.get("[data-slot=code-block-content]");
    expect(content.attributes("data-numbered")).toBe("");
    expect(content.attributes("style")).toContain("counter-reset: line 40");
    const lines = wrapper.findAll("[data-slot=code-block-line]");
    expect(lines.map((line) => line.text())).toEqual(["one", "", "three"]);
    // A blank line keeps a newline so that copying keeps it.
    expect(lines[1]!.get("[data-slot=code-block-line-content]").element.textContent).toBe("\n");
  });

  it("marks diff lines", () => {
    const wrapper = mount(() =>
      h(CodeBlockContent, () => [
        h(CodeBlockLine, { variant: "removed" }, () => "- old"),
        h(CodeBlockLine, { variant: "added" }, () => "+ new"),
      ]),
    );
    expect(wrapper.findAll("[data-slot=code-block-line]").map((line) => line.attributes("data-variant"))).toEqual(["removed", "added"]);
  });

  it("copies the value and announces it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const wrapper = mount(() => h(CodeBlockCopyButton, { value: "pnpm test" }), {
      global: { components: { UButton: ButtonStub } },
    });

    const button = wrapper.get("[data-slot=code-block-copy-button]");
    expect(button.attributes()).toMatchObject({ "aria-label": "Copy", icon: "i-ph-copy-light" });
    await button.trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("pnpm test");
    expect(wrapper.get("[data-slot=code-block-copy-button]").attributes("aria-label")).toBe("Copied");
    expect(wrapper.get("[data-slot=code-block-copy-status]").attributes("aria-live")).toBe("polite");
    expect(wrapper.get("[data-slot=code-block-copy-status]").text()).toBe("Copied");
  });
});

describe("useHighlightedCode", () => {
  const Highlighted = defineComponent({
    props: { code: { required: true, type: String }, language: { required: true, type: String } },
    setup(props) {
      const lines = useHighlightedCode(() => props.code, () => props.language);
      return () => h(CodeBlockContent, () => lines.value.map((line, index) => h(CodeBlockLine, { key: index }, () => line)));
    },
  });

  async function hydrate(code: string, language: string) {
    const app = () => h(Highlighted, { code, language });
    const html = await renderToString(createSSRApp(app));
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createSSRApp(app).mount(container);
    return { container, html, warn };
  }

  it("renders plain lines on the server, hydrates without a mismatch, and colors after mount", async () => {
    const { container, html, warn } = await hydrate('const a = "b"\nexport { a }', "ts");
    expect(html.match(/data-slot="code-block-line"/g)).toHaveLength(2);
    expect(html).not.toContain("--shiki-light");
    await vi.waitFor(() => expect(container.innerHTML).toContain("--shiki-light:"), { timeout: 5_000 });
    expect(container.innerHTML).toContain("--shiki-dark:");
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/hydration/i);
    warn.mockRestore();
    container.remove();
  });

  it("starts with plain lines in the browser and renders unknown languages as text", async () => {
    const wrapper = mount(Highlighted, { props: { code: "plain\ntext", language: "brainfuck" } });
    await flushPromises();
    expect(wrapper.findAll("[data-slot=code-block-line]").map((line) => line.text())).toEqual(["plain", "text"]);
    expect(wrapper.html()).not.toContain("--shiki-light");
  });

  it("drops ANSI escape codes from plain text and renders their colors after mount", async () => {
    const { container, html, warn } = await hydrate("\u001b[31mfailed\u001b[0m", "ansi");
    expect(html).toContain("failed");
    expect(html).not.toContain("\u001b[");
    await vi.waitFor(() => expect(container.innerHTML).toContain("--shiki-light:"), { timeout: 5_000 });
    expect(container.textContent).toBe("failed");
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/hydration/i);
    warn.mockRestore();
    container.remove();
  });
});
