import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toRawMarkdown } from "@vite-hub/docs/server";
import { describe, expect, it } from "vitest";
import { expandCapabilityTools } from "../modules/vitehub-docs/capability-references";

const docsRoot = resolve(import.meta.dirname, "..");
const siteUrl = "https://vitehub.dev";

describe("ViteHub raw Markdown", () => {
  it("keeps the documentation learning paths readable without the navigation component", () => {
    const raw = toRawMarkdown(readFileSync(resolve(docsRoot, "content/docs/index.md"), "utf8"), { siteUrl });
    expect(raw).not.toContain("docs-learning-paths");
    for (const path of ["getting-started", "getting-started/server-primitives", "agents", "ui", "getting-started/build-and-deploy", "reference"]) {
      expect(raw).toContain(`(https://vitehub.dev/docs/${path})`);
    }
  });

  it("expands generated Capability tool contracts before the package conversion", () => {
    const source = expandCapabilityTools([
      "---",
      "title: Database",
      "---",
      "::agent-capability-tools{name=\"db\" variant=\"read\"}",
      "::",
    ].join("\n"), {
      "db.read": {
        tools: [{
          description: "Run one read-only query.",
          inputSchema: { properties: { statement: { type: "string" } }, type: "object" },
          name: "db_query",
        }],
      },
    });
    const raw = toRawMarkdown(source, { siteUrl });

    expect(raw).toContain("#### `db_query`");
    expect(raw).toContain("Run one read-only query.");
    expect(raw).toContain('"statement"');
    expect(raw).not.toContain("agent-capability-tools");
  });

  it("points agents at the rendered page when a Capability has no generated contract", () => {
    const source = "::agent-capability-tools{name=\"missing\"}\n::";
    expect(expandCapabilityTools(source, {})).toBe("_Agent-visible tool contract is available on the rendered documentation page._");
  });

  it("expands Capability tools in the raw copy through the docs options", () => {
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    expect(config).toContain("rawMarkdown: async (markdown: string) => expandCapabilityTools(markdown, await capabilityReferences()),");
  });
});
