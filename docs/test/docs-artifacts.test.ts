import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writeDocsArtifacts } from "../modules/vitehub-docs/artifacts";

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

      const manifest = writeDocsArtifacts({ docsRoot, outputDir });

      expect(manifest.rootPage?.path).toBe("/docs");
      expect(manifest.sections.map(section => section.id)).toEqual(["server-primitives"]);
      expect(manifest.sections[0]?.title).toBe("Server primitives");
      expect(manifest.sections[0]?.icon).toBe("i-lucide-server-cog");
      expect(manifest.sections[0]?.order).toBe(30);
      expect(manifest.sections[0]?.pages.map(page => page.path)).toEqual([
        "/docs/server-primitives",
        "/docs/server-primitives/middle",
        "/docs/server-primitives/kv",
        "/docs/server-primitives/hidden",
      ]);
      expect(manifest.sections[0]?.pages.find(page => page.id === "kv")?.group).toBe("Storage");
      expect(manifest.sections[0]?.pages.find(page => page.id === "hidden")?.navigation).toBe(false);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
