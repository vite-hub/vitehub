import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsRoot = resolve(import.meta.dirname, "..");
const uiDocsRoot = resolve(docsRoot, "content/docs/ui");
const examplesRoot = resolve(docsRoot, "app/examples");
const previewPattern = /^::example\{name="([A-Za-z]+)"[^}]*\}$/gm;

function markdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

const pages = markdownFiles(uiDocsRoot).map((path) => ({
  name: relative(uiDocsRoot, path),
  source: readFileSync(path, "utf8"),
}));
const componentPages = pages.filter(
  (page) => !["index.md", "installation.md", "get-started.md", "built-for-vue.md"].includes(page.name) && !page.name.startsWith("blocks/") && !page.name.startsWith("diagnostics/"),
);
const blockPages = pages.filter((page) => page.name.startsWith("blocks/"));
const previewNames = (source: string) => Array.from(source.matchAll(previewPattern), (match) => match[1]!);

describe("UI documentation", () => {
  it("keeps the overview's text list in sync for raw Markdown readers", () => {
    const source = readFileSync(resolve(uiDocsRoot, "index.md"), "utf8");
    const gallery = source.split('::page-list{exclude="Start"}\n')[1]?.split("\n::\n")[0] ?? "";
    for (const page of [...componentPages, ...blockPages]) {
      const path = `/docs/ui/${page.name.replace(/\.md$/, "")}`;
      expect(gallery, `index.md should list ${path}`).toContain(`](${path})`);
    }
  });

  it("quotes frontmatter descriptions that the docs manifest would split at commas", () => {
    for (const page of pages) {
      const description = /^description: (.*)$/m.exec(page.source)?.[1] ?? "";
      if (description.includes(",")) expect(description, page.name).toMatch(/^".*"$/);
    }
  });

  it("gives every component page the shadcn/ui section order", () => {
    const sections = ["## Installation", "## Usage", "## Accessibility", "## API Reference"];
    for (const page of componentPages) {
      const firstPreview = page.source.indexOf("::example{");
      expect(firstPreview, `${page.name} should open with a live preview`).toBeGreaterThan(0);
      let previous = firstPreview;
      for (const section of sections) {
        const index = page.source.indexOf(`\n${section}\n`);
        expect(index, `${page.name} should have ${section} after the previous section`).toBeGreaterThan(previous);
        previous = index;
      }
      const related = page.source.indexOf("\n## Related\n");
      if (related !== -1) expect(related, `${page.name} should end with ## Related`).toBeGreaterThan(previous);
    }
  });

  it("gives every block page a full-width, resettable preview", () => {
    expect(blockPages.length).toBeGreaterThanOrEqual(2);
    for (const page of blockPages) {
      expect(page.source, page.name).toMatch(/::example\{name="[A-Za-z]+Block" flush reset height=\d+\}/);
      expect(page.source, page.name).toContain("navigation.group: Blocks");
    }
  });

  it("backs every preview with one example file and leaves no example unused", () => {
    const used = new Set(pages.flatMap((page) => previewNames(page.source)));
    for (const name of used) {
      expect(existsSync(resolve(examplesRoot, `${name}.vue`)), `${name}.vue should exist`).toBe(true);
    }
    const examples = readdirSync(examplesRoot)
      .filter((file) => file.endsWith(".vue"))
      .map((file) => basename(file, ".vue"));
    expect(examples.filter((name) => !used.has(name))).toEqual([]);
  });

  it("keeps examples free of network requests", () => {
    for (const file of readdirSync(examplesRoot)) {
      const source = readFileSync(resolve(examplesRoot, file), "utf8");
      expect(source, file).not.toMatch(/\b(?:fetch|\$fetch|useFetch|axios)\s*\(/);
      expect(source, file).not.toMatch(/\bnew (?:WebSocket|EventSource)\b/);
    }
  });

  it("links the Vue ecosystem perspective from the introduction instead of the beginner sidebar", () => {
    const page = readFileSync(resolve(docsRoot, "content/docs/getting-started/built-for-vue.md"), "utf8");

    expect(page).toContain("navigation: false");
    expect(readFileSync(resolve(docsRoot, "content/docs/getting-started/index.md"), "utf8"))
      .toContain("/docs/getting-started/built-for-vue");
    expect(page).toContain("navigation.title: Built for the Vue ecosystem");
    expect(page).toContain("I am Maxi");
  });
});
