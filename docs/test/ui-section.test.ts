import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { docsSidebarGroups } from "@vite-hub/docs";
import { createDocsManifest } from "@vite-hub/docs/server";
import { describe, expect, it } from "vitest";

// The ViteHub UI section starts with the pages that place every part: what it is, how to start, where a bug or a
// feature belongs, and how to move from Reka UI or Nuxt UI. The AI components follow under their own group.
const docsRoot = resolve(import.meta.dirname, "..");
const uiRoot = resolve(docsRoot, "content/docs/ui");
const manifest = await createDocsManifest({ dir: resolve(docsRoot, "content"), base: "/docs" });
const ui = manifest.sections.find(section => section.id === "ui")!;
const read = (page: string) => readFileSync(resolve(uiRoot, `${page}.md`), "utf8");

describe("ViteHub UI section", () => {
  it("lists the start pages, then the AI components, in sidebar order", () => {
    const groups = docsSidebarGroups(ui);
    const rows = (label: string) => groups.find(group => group.label === label)?.pages.map(page => [page.title, page.path]);

    expect(groups.map(group => group.label)).toEqual(["Start", "AI components", "Blocks", "Parts", "Chat", "Collaboration", "Agent work", "Utilities"]);
    expect(rows("Start")).toEqual([
      ["Overview", "/docs/ui"],
      ["Get started", "/docs/ui/get-started"],
      ["Where does it belong?", "/docs/ui/where-does-it-belong"],
      ["From Reka UI", "/docs/ui/from-reka-ui"],
      ["From Nuxt UI", "/docs/ui/from-nuxt-ui"],
    ]);
    expect(rows("AI components")).toEqual([
      ["AI components", "/docs/ui/ai-components"],
      ["Installation", "/docs/ui/installation"],
      ["Chat tutorial", "/docs/ui/chat-tutorial"],
    ]);
  });

  it("links the pages that other sections own instead of copying them", () => {
    const overview = read("index");
    for (const link of [
      "/docs/ui/get-started",
      "/docs/ui/where-does-it-belong",
      "/docs/ui/ai-components",
      "/docs/agents/capabilities/page",
      "/docs/forms/vue",
      "/docs/forms/server-api#one-schema-on-every-surface",
      "/docs/reference/import-paths",
      "/playground?template=ui",
    ]) expect(overview, link).toContain(`](${link})`);
    expect(ui.related).toEqual(expect.arrayContaining(["agents", "forms"]));
  });

  it("gives each layer one row with its owner, docs page, test, and when a bug goes there", () => {
    const page = read("where-does-it-belong");
    const table = page.split("\n## Layers\n")[1]?.split("\n## ")[0] ?? "";
    const lines = table.split("\n").filter(line => line.startsWith("| "));
    expect(lines[0]).toBe("| Layer | Owner | Docs | Test that catches it | A bug goes here when |");
    const rows = lines.slice(2).map(line => line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim()));
    expect(rows.map(row => row[0])).toEqual([
      "Behavior",
      "Gap parts",
      "Look",
      "Forms",
      "Specs",
      "Page work",
      "Chat surfaces",
      "AI components",
      "Docs and playground",
    ]);
    for (const row of rows) {
      expect(row, row[0]).toHaveLength(5);
      expect(row.every(cell => cell.length > 0), row[0]).toBe(true);
      expect(row[1], `${row[0]} owner`).toMatch(/`[^`]+`/);
      expect(row[2], `${row[0]} docs`).toMatch(/\]\((?:\/|https:\/\/)/);
    }
    // The symptom list is static Markdown, so raw Markdown readers and Agents get the same answers.
    const symptoms = page.split("\n## Common symptoms\n")[1] ?? "";
    expect(symptoms.split("\n").filter(line => line.startsWith("- ")).length).toBeGreaterThanOrEqual(8);
    expect(page).not.toMatch(/<script\b/);
  });

  it("covers the Reka UI changes that a migration needs", () => {
    const page = read("from-reka-ui");
    for (const text of ["data-state", "data-open", "AspectRatio", "aspect-ratio", "VisuallyHidden", 'data-slot="visually-hidden"', "`@vite-hub/kit/tags-input`"]) {
      expect(page, text).toContain(text);
    }
    expect(page).toMatch(/```diff \[/);
  });

  it("says what works with Nuxt UI today and that the exit comes later", () => {
    const page = read("from-nuxt-ui");
    expect(page).toContain("## Works today");
    expect(page).toContain("## Not yet");
    expect(page.split(/\s+/).length).toBeLessThan(450);
  });
});
