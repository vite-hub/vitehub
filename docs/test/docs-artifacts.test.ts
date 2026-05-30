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
      mkdirSync(resolve(rootDir, "packages"), { recursive: true });
      writeText(resolve(rootDir, "pnpm-workspace.yaml"), "catalog: {}\n");
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
        "title: Server primitives",
        "navigation.order: 1",
        "icon: i-lucide-server-cog",
        "---",
        "",
        "Server content.",
      ].join("\n"));
      writeText(resolve(docsRoot, "content/docs/server-primitives/kv.md"), [
        "---",
        "title: KV",
        "navigation.order: 2",
        "---",
        "",
        "KV content.",
      ].join("\n"));

      const manifest = writeDocsArtifacts({ docsRoot, repoRoot: rootDir, outputDir });

      expect(manifest.rootPage?.path).toBe("/docs");
      expect(manifest.sections.map(section => section.id)).toEqual(["server-primitives"]);
      expect(manifest.sections[0]?.pages.map(page => page.path)).toEqual([
        "/docs/server-primitives",
        "/docs/server-primitives/kv",
      ]);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
