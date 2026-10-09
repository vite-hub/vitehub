import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsRoot = resolve(import.meta.dirname, "..");
const uiDocsRoot = resolve(docsRoot, "content/docs/ui");
const examplesRoot = resolve(docsRoot, "app/components/content/examples");
const previewPattern = /^::component-preview\{name="([A-Za-z]+)"[^}]*\}$/gm;

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
  (page) =>
    !["index.md", "installation.md", "get-started.md", "built-for-vue.md"].includes(page.name) &&
    !page.name.startsWith("blocks/"),
);
const blockPages = pages.filter((page) => page.name.startsWith("blocks/"));
const previewNames = (source: string) =>
  Array.from(source.matchAll(previewPattern), (match) => match[1]!);

describe("UI documentation", () => {
  it("lists component pages in the overview through the generated gallery", () => {
    const source = readFileSync(resolve(uiDocsRoot, "index.md"), "utf8");

    expect(source).toContain("::ui-component-gallery");
    expect(source).not.toContain(":::u-page-card\n\n---");
    expect(existsSync(resolve(docsRoot, "app/components/content/UiComponentGallery.vue"))).toBe(
      true,
    );
  });

  it("keeps the overview's text list in sync for raw Markdown readers", () => {
    const source = readFileSync(resolve(uiDocsRoot, "index.md"), "utf8");
    const gallery = source.split("::ui-component-gallery\n")[1]?.split("\n::\n")[0] ?? "";
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

  it("gives every component page the same section order", () => {
    const sections = ["## Usage", "## API reference", "## Accessibility", "## Related"];
    for (const page of componentPages) {
      const firstPreview = page.source.indexOf("::component-preview{");
      expect(firstPreview, `${page.name} should open with a live preview`).toBeGreaterThan(0);
      let previous = firstPreview;
      for (const section of sections) {
        const index = page.source.indexOf(`\n${section}\n`);
        expect(
          index,
          `${page.name} should have ${section} after the previous section`,
        ).toBeGreaterThan(previous);
        previous = index;
      }
    }
  });

  it("gives every block page a full-width, resettable preview", () => {
    expect(blockPages.length).toBeGreaterThanOrEqual(3);
    for (const page of blockPages) {
      expect(page.source, page.name).toMatch(
        /::component-preview\{name="[A-Za-z]+Block" flush reset\}/,
      );
      expect(page.source, page.name).toContain("navigation.group: Console");
    }
  });

  it("backs every preview with one example file and leaves no example unused", () => {
    const used = new Set(pages.flatMap((page) => previewNames(page.source)));
    for (const name of used) {
      expect(existsSync(resolve(examplesRoot, `${name}.vue`)), `${name}.vue should exist`).toBe(
        true,
      );
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

  it("renders previews with a live stage and the running source", () => {
    const preview = readFileSync(
      resolve(docsRoot, "app/components/content/ComponentPreview.vue"),
      "utf8",
    );

    expect(preview).toContain('import highlighter from "#mdc-highlighter"');
    expect(preview).toContain('import.meta.glob("./examples/*.vue")');
    expect(preview).toContain('query: "?raw"');
    expect(preview).toContain("Live example");
    expect(preview).toContain('class="component-preview-source border-t border-default"');
    expect(preview).not.toContain('role="tablist"');
    expect(preview).not.toContain('role="tab"');
    expect(preview).toContain('<MDC :value="sourceBlock"');
    expect(preview).toContain(':parser-options="sourceParserOptions"');
    expect(preview).toContain('@click="copy(source)"');
    expect(preview).toContain('<component :is="example" :key="resetKey" />');
    expect(preview).not.toContain("<code>{{ source }}</code>");
  });

  it("loads previews through the public Nuxt module", () => {
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const manifest = readFileSync(resolve(docsRoot, "package.json"), "utf8");

    expect(config).toContain('"@vite-hub/ui/nuxt"');
    expect(manifest).toContain('"@vite-hub/ui": "workspace:*"');
  });

  it("gives component pages the shared article layout and page outline", () => {
    const page = readFileSync(resolve(docsRoot, "app/pages/docs/[...slug].vue"), "utf8");
    const article = readFileSync(resolve(docsRoot, "app/components/DocsArticle.vue"), "utf8");

    expect(page).toContain('<DocsArticle v-else-if="page" :page="page"');
    expect(article).toContain("UContentToc");
    expect(article).toContain('aria-label="Page outline"');
    expect(article).toContain("min-w-0");
  });

  it("gives invocation previews fixed-height containing blocks", () => {
    const invocation = readFileSync(resolve(examplesRoot, "InvocationExample.vue"), "utf8");
    const inspector = readFileSync(resolve(examplesRoot, "InvocationInspectorExample.vue"), "utf8");

    expect(invocation).toContain('<div class="h-[34rem]');
    expect(invocation).toContain('class="h-full"');
    expect(inspector).toContain('<div class="mx-auto h-[36rem]');
    expect(inspector).toContain('class="h-full border-x border-default"');
  });

  it("switches sections with the primitive rail instead of a product selector", () => {
    const sidebarTop = readFileSync(
      resolve(docsRoot, "app/components/DocsAsideLeftTop.vue"),
      "utf8",
    );
    const sidebars = readFileSync(resolve(docsRoot, "app/components/DocsSidebars.vue"), "utf8");

    expect(sidebars).toContain("<DocsRail />");
    expect(sidebarTop).toContain('<h2 class="vh-docs-panel-title">');
    expect(sidebarTop).not.toContain("USelectMenu");
    expect(sidebarTop).not.toContain("getDocsSectionSelectItems");
  });

  it("keeps the docs sidebar visible without a duplicate picker or search", () => {
    const sidebarTop = readFileSync(
      resolve(docsRoot, "app/components/DocsAsideLeftTop.vue"),
      "utf8",
    );
    const sidebar = readFileSync(resolve(docsRoot, "app/components/DocsAsideLeftBody.vue"), "utf8");
    const layout = readFileSync(resolve(docsRoot, "app/layouts/docs.vue"), "utf8");

    expect(sidebar).toContain("flex: 1 1 0");
    expect(sidebar).toContain("min-height: 0");
    expect(sidebarTop).not.toContain("<details");
    expect(sidebarTop).not.toContain("UContentSearchButton");
    expect(layout).toContain("height: calc(100dvh - var(--ui-header-height));");
  });

  it("lists the Vue ecosystem perspective in the getting started sidebar", () => {
    const page = readFileSync(resolve(docsRoot, "content/docs/ui/built-for-vue.md"), "utf8");

    expect(page).not.toContain("navigation: false");
    expect(page).toContain("navigation.title: Why Vue?");
    expect(page).toContain("The server packages work independently of Vue.");
  });
});
