import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readDocsArtifactsManifest, writeDocsArtifacts } from "../modules/vitehub-docs/artifacts";

function writeText(filePath: string, contents: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

describe("writeDocsArtifacts", () => {
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
      expect(readFileSync(resolve(outputDir, "raw/docs.md"), "utf8")).toBe("# ViteHub docs\n\nStart here.\n");
      expect(readFileSync(resolve(outputDir, "raw/docs/server-primitives.md"), "utf8")).toBe("# Overview\n\nServer content.\n");
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
      ].join("\n"));

      writeDocsArtifacts({ docsRoot, outputDir });
      const raw = readFileSync(resolve(outputDir, "raw/docs.md"), "utf8");

      expect(raw).toContain("# ViteHub docs");
      expect(raw).toContain("- [Get started](https://vitehub.dev/docs/getting-started) — Run one local result.");
      expect(raw).toContain("| Choice | Result |");
      expect(raw).toContain("> **Warning**");
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
      expect(raw).not.toMatch(/<u-|<table/);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("rejects cached manifests from before the current schema", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "vitehub-docs-artifacts-"));
    const outputDir = resolve(rootDir, ".generated");

    try {
      writeText(resolve(outputDir, "docs-manifest.mjs"), [
        "export const docsManifest = {\"rootPage\":null,\"sections\":[]};",
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
