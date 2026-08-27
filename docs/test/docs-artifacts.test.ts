import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readDocsArtifactsManifest, writeDocsArtifacts } from "../modules/vitehub-docs/artifacts";
import { toRawMarkdown } from "../modules/vitehub-docs/artifacts/raw-markdown";

function writeText(filePath: string, contents: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

describe("writeDocsArtifacts", () => {
  it("preserves semantic indentation at document boundaries", () => {
    expect(toRawMarkdown("---\ntitle: Boundary\n---\n    first\n    second")).toBe("# Boundary\n\n    first\n    second\n");
    expect(toRawMarkdown("    first\n    second\n")).toBe("    first\n    second\n");
  });

  it("parses YAML block scalar titles", () => {
    expect(toRawMarkdown("---\ntitle: >\n  Source-backed raw Markdown\n---\nBody")).toBe(
      "# Source-backed raw Markdown\n\nBody\n",
    );
  });

  it("makes rendered reference-style links portable", () => {
    expect(toRawMarkdown([
      "[Install][install]",
      "",
      "[install]: /docs/getting-started \"Get started\"",
      "[external]: https://example.com/docs",
      "",
      "```md",
      "[literal]: /docs/literal",
      "```",
      "",
      "<pre>",
      "[literal-html]: /docs/literal-html",
      "</pre>",
    ].join("\n"))).toBe([
      "[Install][install]",
      "",
      "[install]: https://vitehub.dev/docs/getting-started \"Get started\"",
      "[external]: https://example.com/docs",
      "",
      "```md",
      "[literal]: /docs/literal",
      "```",
      "",
      "<pre>",
      "[literal-html]: /docs/literal-html",
      "</pre>",
      "",
    ].join("\n"));
  });

  it("parses complete reference definitions before rewriting destinations", () => {
    expect(toRawMarkdown([
      "> [quote\\]d]: /docs/quoted",
      "- [listed]: /docs/listed",
      "[continued]:",
      "  </docs/continued>",
      "[malformed]: </docs/malformed",
      "    [literal]: /docs/code",
      "- > [nested]: /docs/nested",
      "[unterminated]: /docs/no \"title",
      "[a[b]: /docs/no",
    ].join("\n"))).toBe([
      "> [quote\\]d]: https://vitehub.dev/docs/quoted",
      "- [listed]: https://vitehub.dev/docs/listed",
      "[continued]:",
      "  <https://vitehub.dev/docs/continued>",
      "[malformed]: </docs/malformed",
      "    [literal]: /docs/code",
      "- > [nested]: https://vitehub.dev/docs/nested",
      "[unterminated]: /docs/no \"title",
      "[a[b]: /docs/no",
      "",
    ].join("\n"));
  });

  it("handles inline destination and code-span grammar boundaries", () => {
    expect(toRawMarkdown([
      "[Guide](</docs/getting started>)",
      "`[literal](/docs/literal)\\` [rendered](/docs/rendered)",
    ].join("\n"))).toBe([
      "[Guide](<https://vitehub.dev/docs/getting started>)",
      "`[literal](/docs/literal)\\` [rendered](https://vitehub.dev/docs/rendered)",
      "",
    ].join("\n"));
  });

  it("does not start type-7 HTML blocks inside paragraphs", () => {
    expect(toRawMarkdown([
      "Paragraph",
      "<custom-tag>",
      "[rendered](/docs/rendered)",
    ].join("\n"))).toContain("[rendered](https://vitehub.dev/docs/rendered)");
  });

  it("keeps protected indented code separate from following references", () => {
    expect(toRawMarkdown([
      "    [literal]: /docs/literal",
      "[rendered]: /docs/rendered",
    ].join("\n"))).toBe([
      "    [literal]: /docs/literal",
      "[rendered]: https://vitehub.dev/docs/rendered",
      "",
    ].join("\n"));
  });

  it("preserves raw HTML blocks inside blockquotes", () => {
    expect(toRawMarkdown([
      "> <pre>",
      "> [literal](/docs/literal)",
      "> ::warning",
      "> </pre>",
      "[rendered](/docs/rendered)",
    ].join("\n"))).toBe([
      "> <pre>",
      "> [literal](/docs/literal)",
      "> ::warning",
      "> </pre>",
      "[rendered](https://vitehub.dev/docs/rendered)",
      "",
    ].join("\n"));
  });

  it("parses page-card metadata as YAML", () => {
    expect(toRawMarkdown([
      "::u-page-grid",
      "  :::u-page-card",
      "  ---",
      "  title: >",
      "    Agent Definitions",
      "  description: Source-backed docs.",
      "  to: /docs/agents",
      "  ---",
      "  :::",
      "::",
    ].join("\n"))).toBe("- [Agent Definitions](https://vitehub.dev/docs/agents) — Source-backed docs.\n");
  });

  it("rewrites links whose labels contain balanced brackets", () => {
    expect(toRawMarkdown([
      "[API [beta]](/docs/api)",
      "![Diagram [dark]](/images/dark.png)",
      "\\[Escaped [label]](/docs/escaped)",
    ].join("\n"))).toBe([
      "[API [beta]](https://vitehub.dev/docs/api)",
      "![Diagram [dark]](https://vitehub.dev/images/dark.png)",
      "\\[Escaped [label]](/docs/escaped)",
      "",
    ].join("\n"));
  });

  it("keeps list-prefixed fence markers literal inside fenced examples", () => {
    expect(toRawMarkdown([
      "```md",
      "- ```",
      "[Literal link](/docs/literal)",
      "::warning",
      "Literal directive.",
      "::",
      "```",
      "[Rendered link](/docs/rendered)",
    ].join("\n"))).toBe([
      "```md",
      "- ```",
      "[Literal link](/docs/literal)",
      "::warning",
      "Literal directive.",
      "::",
      "```",
      "[Rendered link](https://vitehub.dev/docs/rendered)",
      "",
    ].join("\n"));
  });

  it("builds a docs manifest from the unified content tree only", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "vitehub-docs-artifacts-"));
    const docsRoot = resolve(rootDir, "docs");
    const outputDir = resolve(rootDir, ".generated");

    try {
      writeText(resolve(docsRoot, "content/docs/index.md"), [
        "---",
        "title: ViteHub docs",
        "navigation.order: 0",
        "---",
        "",
        "Start here.",
      ].join("\n"));
      writeText(resolve(docsRoot, "content/docs/server-primitives/index.md"), [
        "---",
        "title: Overview",
        "navigation.order: 1",
        "---",
        "",
        "Server content.",
      ].join("\n"));
      writeText(resolve(docsRoot, "content/docs/server-primitives/.navigation.yml"), [
        "title: Server primitives",
        "icon: i-lucide-server-cog",
        "order: 30",
      ].join("\n"));
      writeText(resolve(docsRoot, "content/docs/server-primitives/kv.md"), [
        "---",
        "title: KV",
        "navigation.order: 2",
        "navigation.group: Storage",
        "---",
        "",
        "KV content.",
      ].join("\n"));
      writeText(resolve(docsRoot, "content/docs/server-primitives/middle.md"), [
        "---",
        "title: Middle",
        "navigation.order: 1.5",
        "---",
        "",
        "Ordered between the overview and KV.",
      ].join("\n"));
      writeText(resolve(docsRoot, "content/docs/server-primitives/hidden.md"), [
        "---",
        "title: Hidden",
        "navigation: false",
        "---",
        "",
        "Hidden content.",
      ].join("\n"));
      writeText(resolve(docsRoot, "content/blog/1.agents.md"), "# Agents blog\n");
      writeText(resolve(docsRoot, "content/trust/about.md"), "# About ViteHub\n");
      writeText(resolve(outputDir, "raw/docs/removed.md"), "stale\n");

      const manifest = writeDocsArtifacts({ docsRoot, outputDir });

      expect(manifest.version).toBe(1);
      expect(manifest.rootPage?.path).toBe("/docs");
      expect(manifest.sections.map(section => section.id)).toEqual(["server-primitives"]);
      expect(manifest.sections[0]?.title).toBe("Server primitives");
      expect(manifest.sections[0]?.icon).toBe("i-lucide-server-cog");
      expect(manifest.sections[0]?.lanes).toEqual(["agents", "server-primitives"]);
      expect(manifest.sections[0]?.order).toBe(30);
      expect(manifest.sections[0]?.pages.map(page => page.path)).toEqual([
        "/docs/server-primitives",
        "/docs/server-primitives/middle",
        "/docs/server-primitives/kv",
        "/docs/server-primitives/hidden",
      ]);
      expect(manifest.sections[0]?.pages.find(page => page.id === "kv")?.group).toBe("Storage");
      expect(manifest.sections[0]?.pages.find(page => page.id === "kv")?.lanes).toEqual(["agents", "server-primitives"]);
      expect(manifest.sections[0]?.pages.find(page => page.id === "hidden")?.navigation).toBe(false);
      expect(readDocsArtifactsManifest(outputDir)?.sections[0]?.pages.map(page => page.path)).toEqual([
        "/docs/server-primitives",
        "/docs/server-primitives/middle",
        "/docs/server-primitives/kv",
        "/docs/server-primitives/hidden",
      ]);
      expect(readFileSync(resolve(outputDir, "raw/docs.md"), "utf8")).toBe("# ViteHub docs\n\nStart here.\n");
      expect(readFileSync(resolve(outputDir, "raw/docs/server-primitives.md"), "utf8")).toBe("# Overview\n\nServer content.\n");
      expect(readFileSync(resolve(outputDir, "raw/blog/agents.md"), "utf8")).toBe("# Agents blog\n");
      expect(readFileSync(resolve(outputDir, "raw/about.md"), "utf8")).toBe("# About ViteHub\n");
      expect(existsSync(resolve(outputDir, "raw/docs/removed.md"))).toBe(false);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("publishes source-backed Markdown without presentation component serialization", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "vitehub-docs-raw-"));
    const docsRoot = resolve(rootDir, "docs");
    const outputDir = resolve(rootDir, ".generated");

    try {
      writeText(resolve(docsRoot, "content/docs/index.md"), [
        "---",
        "title: ViteHub docs",
        "---",
        "",
        "::u-page-grid",
        "  :::u-page-card",
        "  ---",
        "  title: Get started",
        "  description: Run one local result.",
        "  to: /docs/getting-started",
        "  ---",
        "  :::",
        "::",
        "",
        "| Choice | Result |",
        "| --- | --- |",
        "| Local | Works |",
        "",
        "::warning",
        "Keep secrets out of examples.",
        "::",
        "",
        "    ::warning",
        "    This indented code block remains literal.",
        "    ::",
        "",
        "\t::tip",
        "\tThis tab-indented code block remains literal.",
        "\t::",
        "",
        "::steps",
        "      ::warning",
        "      This nested indented code block remains literal.",
        "      ::",
        "  \t  ::important",
        "  \t  This mixed-indentation code block remains literal.",
        "  \t  ::",
        "::",
        "",
        "[Rendered link](/docs/rendered) and `[literal link](/docs/literal)`.",
        "[`skills()`](/docs/capabilities/skills) and [before `code` after](/docs/code-label).",
        "\\[escaped link](/docs/escaped-link) and \\![rendered link](/docs/escaped-image).",
        "Escaped \\` delimiter and [rendered link](/docs/escaped) \\` stay outside code.",
        "`multiline literal",
        "[link](/docs/multiline)` and [rendered link](/docs/after-code).",
        "Unmatched ````` run, then ``[literal link](/docs/after-unmatched)`` and [rendered link](/docs/outside-span).",
        "",
        "    [indented literal link](/docs/indented)",
        "\t[tab-indented literal link](/docs/tab-indented)",
        "- item",
        "    [list child](/docs/list-child)",
        "",
        ">     [blockquote code](/docs/blockquote-code)",
        "- item",
        "",
        "      [list code](/docs/list-code)",
        "`multiline code",
        "    indented continuation",
        "[multiline indented literal](/docs/multiline-indented)`",
        "",
        "::video{src=\"/demo.mp4\"}",
        "Keep this semantic directive.",
        "::",
        "",
        "```md",
        "::warning",
        "This is example source.",
        "::",
        "```",
        "",
        "````md",
        "```md",
        "::warning",
        "This nested fence remains literal.",
        "::",
        "```",
        "::u-page-grid",
        "````",
        "",
        "```md",
        "```js",
        "::warning",
        "This same-length marker with an info string remains literal.",
        "::",
        "::u-page-grid",
        "```",
        "",
        "~~~md",
        "~~~js",
        "::warning",
        "This tilde marker with an info string remains literal.",
        "::",
        "~~~",
        "",
        "- ```md",
        "  ::warning",
        "  This list-nested fence remains literal.",
        "  ::",
        "  ```",
        "",
        "- ```md",
        "  [unclosed list literal](/docs/unclosed-list-literal)",
        "",
        "[rendered after unclosed list fence](/docs/after-unclosed-list-fence)",
        "",
        "    ```md",
        "    [code-indented fence literal](/docs/code-indented-fence)",
        "",
        "[rendered after code-indented fence](/docs/after-code-indented-fence)",
        "",
        "```md",
        "```\u00a0",
        "::warning",
        "This Unicode-suffixed marker remains literal.",
        "::",
        "```",
        "",
        "<pre>",
        "[raw HTML literal](/docs/raw-html-literal)",
        "::warning",
        "Raw HTML directive remains literal.",
        "::",
        "::u-page-grid",
        "  :::u-page-card",
        "  ---",
        "  title: Raw HTML card",
        "  to: /docs/raw-html-card",
        "  ---",
        "  :::",
        "::",
        "</pre>",
        "[rendered after raw HTML](https://vitehub.dev/docs/already-absolute)",
        "",
        "<div>",
        "::warning",
        "Raw block tag directive remains literal.",
        "::",
        "[raw block tag link](/docs/raw-block-tag)",
        "</div>",
        "",
        "<!--",
        "::warning",
        "[raw comment link](/docs/raw-comment)",
        "-->",
        "<!-- closed -->",
        "[rendered after one-line comment](/docs/after-one-line-comment)",
        "<?closed?>",
        "[rendered after processing instruction](/docs/after-processing-instruction)",
        "<!DOCTYPE html>",
        "[rendered after declaration](/docs/after-declaration)",
        "<![CDATA[closed]]>",
        "[rendered after CDATA](/docs/after-cdata)",
        "",
        "> ~~~md",
        "> [blockquote literal](/docs/blockquote-literal)",
        "> ~~~",
        "",
        "- > ```md",
        "  > [list blockquote literal](/docs/list-blockquote-literal)",
        "  > ```",
        "",
        "> ```md",
        "> [unclosed blockquote literal](/docs/unclosed-blockquote-literal)",
        "",
        "[rendered after unclosed blockquote](/docs/after-unclosed-blockquote)",
        "",
        "::steps",
        "  ::tabs",
        "    :::tabs-item{label=\"Example\"}",
        "      ```md",
        "      ::u-page-grid",
        "        :::u-page-card",
        "        ---",
        "        title: Literal card",
        "        ---",
        "        :::",
        "      ::",
        "        nested: value",
        "      ```",
        "    :::",
        "  ::",
        "::",
        "",
        "::tabs",
        "  ::u-page-grid",
        "    :::u-page-card",
        "    ---",
        "    title: Nested card",
        "    to: /docs/nested-card",
        "    ---",
        "    :::",
        "  ::",
        "::",
      ].join("\n"));

      writeDocsArtifacts({ docsRoot, outputDir });
      const raw = readFileSync(resolve(outputDir, "raw/docs.md"), "utf8");

      expect(raw).toContain("# ViteHub docs");
      expect(raw).toContain("- [Get started](https://vitehub.dev/docs/getting-started) — Run one local result.");
      expect(raw).toContain("| Choice | Result |");
      expect(raw).toContain("> **Warning**");
      expect(raw).toContain("    ::warning\n    This indented code block remains literal.\n    ::");
      expect(raw).toContain("\t::tip\n\tThis tab-indented code block remains literal.\n\t::");
      expect(raw).toContain("    ::warning\n    This nested indented code block remains literal.\n    ::");
      expect(raw).toContain("\t  ::important\n\t  This mixed-indentation code block remains literal.\n\t  ::");
      expect(raw).toContain("[Rendered link](https://vitehub.dev/docs/rendered) and `[literal link](/docs/literal)`.");
      expect(raw).toContain("[`skills()`](https://vitehub.dev/docs/capabilities/skills) and [before `code` after](https://vitehub.dev/docs/code-label).");
      expect(raw).toContain("\\[escaped link](/docs/escaped-link) and \\![rendered link](https://vitehub.dev/docs/escaped-image).");
      expect(raw).toContain("Escaped \\` delimiter and [rendered link](https://vitehub.dev/docs/escaped) \\` stay outside code.");
      expect(raw).toContain("`multiline literal\n[link](/docs/multiline)` and [rendered link](https://vitehub.dev/docs/after-code).");
      expect(raw).toContain("Unmatched ````` run, then ``[literal link](/docs/after-unmatched)`` and [rendered link](https://vitehub.dev/docs/outside-span).");
      expect(raw).toContain("    [indented literal link](/docs/indented)");
      expect(raw).toContain("\t[tab-indented literal link](/docs/tab-indented)");
      expect(raw).toContain("- item\n    [list child](https://vitehub.dev/docs/list-child)");
      expect(raw).toContain(">     [blockquote code](/docs/blockquote-code)");
      expect(raw).toContain("- item\n\n      [list code](/docs/list-code)");
      expect(raw).toContain("`multiline code\n    indented continuation\n[multiline indented literal](/docs/multiline-indented)`");
      expect(raw).toContain("::video{src=\"/demo.mp4\"}\nKeep this semantic directive.\n::");
      expect(raw).toContain("```md\n::warning\nThis is example source.\n::\n```");
      expect(raw).toContain([
        "````md",
        "```md",
        "::warning",
        "This nested fence remains literal.",
        "::",
        "```",
        "::u-page-grid",
        "````",
      ].join("\n"));
      expect(raw).toContain([
        "```md",
        "```js",
        "::warning",
        "This same-length marker with an info string remains literal.",
        "::",
        "::u-page-grid",
        "```",
      ].join("\n"));
      expect(raw).toContain([
        "~~~md",
        "~~~js",
        "::warning",
        "This tilde marker with an info string remains literal.",
        "::",
        "~~~",
      ].join("\n"));
      expect(raw).toContain([
        "- ```md",
        "  ::warning",
        "  This list-nested fence remains literal.",
        "  ::",
        "  ```",
      ].join("\n"));
      expect(raw).toContain("- ```md\n  [unclosed list literal](/docs/unclosed-list-literal)");
      expect(raw).toContain("[rendered after unclosed list fence](https://vitehub.dev/docs/after-unclosed-list-fence)");
      expect(raw).toContain("    ```md\n    [code-indented fence literal](/docs/code-indented-fence)");
      expect(raw).toContain("[rendered after code-indented fence](https://vitehub.dev/docs/after-code-indented-fence)");
      expect(raw).toContain("```md\n```\u00a0\n::warning\nThis Unicode-suffixed marker remains literal.\n::\n```");
      expect(raw).toContain([
        "<pre>",
        "[raw HTML literal](/docs/raw-html-literal)",
        "::warning",
        "Raw HTML directive remains literal.",
        "::",
        "::u-page-grid",
        "  :::u-page-card",
        "  ---",
        "  title: Raw HTML card",
        "  to: /docs/raw-html-card",
        "  ---",
        "  :::",
        "::",
        "</pre>",
      ].join("\n"));
      expect(raw).toContain("<div>\n::warning\nRaw block tag directive remains literal.\n::\n[raw block tag link](/docs/raw-block-tag)\n</div>");
      expect(raw).toContain("<!--\n::warning\n[raw comment link](/docs/raw-comment)\n-->");
      expect(raw).toContain("<!-- closed -->\n[rendered after one-line comment](https://vitehub.dev/docs/after-one-line-comment)");
      expect(raw).toContain("<?closed?>\n[rendered after processing instruction](https://vitehub.dev/docs/after-processing-instruction)");
      expect(raw).toContain("<!DOCTYPE html>\n[rendered after declaration](https://vitehub.dev/docs/after-declaration)");
      expect(raw).toContain("<![CDATA[closed]]>\n[rendered after CDATA](https://vitehub.dev/docs/after-cdata)");
      expect(raw).toContain("> ~~~md\n> [blockquote literal](/docs/blockquote-literal)\n> ~~~");
      expect(raw).toContain("- > ```md\n  > [list blockquote literal](/docs/list-blockquote-literal)\n  > ```");
      expect(raw).toContain("> ```md\n> [unclosed blockquote literal](/docs/unclosed-blockquote-literal)");
      expect(raw).toContain("[rendered after unclosed blockquote](https://vitehub.dev/docs/after-unclosed-blockquote)");
      expect(raw).toContain([
        "### Example",
        "",
        "```md",
        "::u-page-grid",
        "  :::u-page-card",
        "  ---",
        "  title: Literal card",
        "  ---",
        "  :::",
        "::",
        "  nested: value",
        "```",
      ].join("\n"));
      expect(raw).toContain("- [Nested card](https://vitehub.dev/docs/nested-card)");
      expect(raw).not.toMatch(/<u-|<table/);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("rejects cached manifests that do not match the current schema", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "vitehub-docs-artifacts-"));
    const outputDir = resolve(rootDir, ".generated");

    try {
      writeText(resolve(outputDir, "docs-manifest.mjs"), [
        "export const docsManifest = {\"version\":1,\"sections\":[{\"pages\":[{\"path\":3}]}]};",
        "",
        "export default docsManifest;",
        "",
      ].join("\n"));

      expect(readDocsArtifactsManifest(outputDir)).toBeNull();
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
