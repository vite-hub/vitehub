import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { filterFwBlocksForFramework, rewriteFrameworkDocLinks, writeDocsArtifacts } from "../modules/vitehub-docs/artifacts";

function writeText(filePath: string, contents: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeJson(filePath: string, value: unknown) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("filterFwBlocksForFramework", () => {
  it("keeps only matching explicit id blocks", () => {
    const source = [
      "# Getting started",
      "",
      "::fw{id=\"vite:dev vite:build\"}",
      "Vite setup",
      "::",
      "",
      "::fw{id=\"nitro:dev nitro:build\"}",
      "Nitro setup",
      "::",
      "",
      "::fw{id=\"nuxt:dev nuxt:build\"}",
      "Nuxt app",
      "::",
    ].join("\n");

    const filtered = filterFwBlocksForFramework(source, "nitro");

    expect(filtered).toContain("# Getting started");
    expect(filtered).toContain("Nitro setup");
    expect(filtered).not.toContain("::fw");
    expect(filtered).not.toContain("Vite setup");
    expect(filtered).not.toContain("Nuxt app");
  });

  it("keeps matching shorthand framework blocks", () => {
    const source = [
      "::fw{nitro nuxt}",
      "Server platforms",
      "::",
      "",
      "::fw{vite}",
      "Vite only",
      "::",
    ].join("\n");

    expect(filterFwBlocksForFramework(source, "nitro")).toContain("Server platforms");
    expect(filterFwBlocksForFramework(source, "nitro")).not.toContain("Vite only");
    expect(filterFwBlocksForFramework(source, "vite")).toContain("Vite only");
    expect(filterFwBlocksForFramework(source, "vite")).not.toContain("Server platforms");
  });

  it("preserves frontmatter and non-fw markdown", () => {
    const source = [
      "---",
      "title: Providers",
      "---",
      "",
      "# Providers",
      "",
      "Regular paragraph.",
    ].join("\n");

    expect(filterFwBlocksForFramework(source, "nuxt")).toBe(source);
  });

  it("preserves malformed fw blocks", () => {
    const source = [
      "# Broken",
      "",
      "::fw{nitro}",
      "Unclosed body",
    ].join("\n");

    expect(filterFwBlocksForFramework(source, "nitro")).toBe(source);
  });
});

describe("rewriteFrameworkDocLinks", () => {
  it("rewrites package docs links to absolute framework routes", () => {
    const source = [
      "Start with [Quickstart](./quickstart).",
      "",
      ":::u-page-card",
      "---",
      "to: ./providers/cloudflare",
      "---",
      ":::",
    ].join("\n");

    expect(rewriteFrameworkDocLinks(source, "vite", "kv", "index.md")).toContain("[Quickstart](/docs/vite/kv/quickstart)");
    expect(rewriteFrameworkDocLinks(source, "vite", "kv", "index.md")).toContain("to: /docs/vite/kv/providers/cloudflare");
  });

  it("rewrites nested index links without leaving index in the route", () => {
    const source = [
      "- [Overview](../index)",
      "- [Usage](../usage#methods)",
    ].join("\n");

    const rewritten = rewriteFrameworkDocLinks(source, "nuxt", "kv", "providers/cloudflare.md");

    expect(rewritten).toContain("[Overview](/docs/nuxt/kv)");
    expect(rewritten).toContain("[Usage](/docs/nuxt/kv/usage#methods)");
  });

  it("rewrites cross-section links from generated route locations", () => {
    const source = [
      "- [KV overview](../kv)",
      "- [Cloudflare](../kv/providers/cloudflare)",
    ].join("\n");

    const rewritten = rewriteFrameworkDocLinks(source, "nitro", "providers", "cloudflare.md");

    expect(rewritten).toContain("[KV overview](/docs/nitro/kv)");
    expect(rewritten).toContain("[Cloudflare](/docs/nitro/kv/providers/cloudflare)");
  });

  it("leaves external, absolute, hash, and image links unchanged", () => {
    const source = [
      "[External](https://example.com)",
      "[Absolute](/docs/nuxt/kv)",
      "[Hash](#usage)",
      "![Image](./diagram.png)",
    ].join("\n");

    expect(rewriteFrameworkDocLinks(source, "vite", "kv", "usage.md")).toBe(source);
  });
});

describe("writeDocsArtifacts", () => {
  it("normalizes flat showcase manifests and example package manifests", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "vitehub-docs-artifacts-"));
    const docsRoot = resolve(rootDir, "docs");
    const outputDir = resolve(rootDir, ".generated");

    try {
      mkdirSync(docsRoot, { recursive: true });
      writeText(resolve(rootDir, "pnpm-workspace.yaml"), [
        "catalog:",
        "  nitro: 3.0.0",
        "  vite: 6.2.0",
      ].join("\n"));

      writeJson(resolve(rootDir, "packages/demo/package.json"), {
        name: "@vitehub/demo",
        version: "1.2.3",
      });
      writeJson(resolve(rootDir, "packages/demo/examples/showcase.json"), {
        label: "Demo",
        frameworks: {
          vite: {
            run: "src/main.ts",
          },
          nitro: {
            buildRun: "server/api/demo.get.ts",
          },
          nuxt: {
            define: "server/utils/demo.ts",
            run: "server/api/demo.get.ts",
          },
        },
      });

      writeJson(resolve(rootDir, "packages/demo/examples/vite/package.json"), {
        private: true,
        dependencies: {
          "@vitehub/demo": "workspace:*",
          vite: "catalog:",
        },
      });
      writeText(resolve(rootDir, "packages/demo/examples/vite/vite.config.ts"), "export default {};\n");
      writeText(resolve(rootDir, "packages/demo/examples/vite/src/main.ts"), "console.log('vite');\n");

      writeJson(resolve(rootDir, "packages/demo/examples/nitro/package.json"), {
        private: true,
        dependencies: {
          "@vitehub/demo": "workspace:*",
          nitro: "catalog:",
        },
      });
      writeText(resolve(rootDir, "packages/demo/examples/nitro/nitro.config.ts"), "export default {};\n");
      writeText(resolve(rootDir, "packages/demo/examples/nitro/server/api/demo.get.ts"), "export default () => 'nitro';\n");

      writeJson(resolve(rootDir, "packages/demo/examples/nuxt/package.json"), {
        private: true,
        dependencies: {
          "@vitehub/demo": "workspace:*",
          nitro: "catalog:",
        },
      });
      writeText(resolve(rootDir, "packages/demo/examples/nuxt/nuxt.config.ts"), "export default {};\n");
      writeText(resolve(rootDir, "packages/demo/examples/nuxt/server/api/demo.get.ts"), "export default () => 'nuxt';\n");
      writeText(resolve(rootDir, "packages/demo/examples/nuxt/server/utils/demo.ts"), "export const demo = true;\n");

      const manifest = writeDocsArtifacts({ docsRoot, repoRoot: rootDir, outputDir });
      const example = manifest.examples.find(item => item.pkg === "demo");

      expect(example).toBeTruthy();
      expect(example?.frameworks.vite.modes.dev.phases.configure).toBe("vite.config.ts");
      expect(example?.frameworks.nitro.modes.build.phases.configure).toBe("nitro.config.ts");
      expect(example?.frameworks.nuxt.modes.dev.phases.configure).toBe("nuxt.config.ts");
      expect(example?.frameworks.nitro.modes.build.phases.run).toBe("server/api/demo.get.ts");

      const nitroPackage = example?.files.nitro.find(file => file.path === "package.json");
      expect(nitroPackage?.code).not.toContain("\"private\": true");
      expect(nitroPackage?.code).not.toContain("catalog:");
      expect(nitroPackage?.code).not.toContain("workspace:*");
      expect(nitroPackage?.code).toContain("\"@vitehub/demo\": \"1.2.3\"");
      expect(nitroPackage?.code).toContain("\"nitro\": \"3.0.0\"");
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
