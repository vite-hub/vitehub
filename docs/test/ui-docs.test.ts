import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsRoot = resolve(import.meta.dirname, "..");
const uiDocsRoot = resolve(docsRoot, "content/docs/ui");
const examplesRoot = resolve(docsRoot, "app/components/content/examples");
// The shared docs shell ships with @vite-hub/docs.
const packageRoot = resolve(docsRoot, "../packages/docs");
const packageApp = resolve(packageRoot, "runtime/app");
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
  (page) => !["index.md", "installation.md", "get-started.md", "built-for-vue.md"].includes(page.name) && !page.name.startsWith("blocks/"),
);
const blockPages = pages.filter((page) => page.name.startsWith("blocks/"));
const previewNames = (source: string) => Array.from(source.matchAll(previewPattern), (match) => match[1]!);

describe("UI documentation", () => {
  it("lists component pages in the overview through the generated gallery", () => {
    const source = readFileSync(resolve(uiDocsRoot, "index.md"), "utf8");

    expect(source).toContain("::ui-component-gallery");
    expect(source).not.toContain(":::u-page-card\n\n---");
    expect(existsSync(resolve(docsRoot, "app/components/content/UiComponentGallery.vue"))).toBe(true);
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

  it("gives every component page the shadcn/ui section order", () => {
    const sections = ["## Installation", "## Usage", "## Accessibility", "## API Reference"];
    for (const page of componentPages) {
      const firstPreview = page.source.indexOf("::component-preview{");
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
      expect(page.source, page.name).toMatch(/::component-preview\{name="[A-Za-z]+Block" flush reset\}/);
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

  it("renders previews with a live stage and the running source", () => {
    const preview = readFileSync(
      resolve(docsRoot, "app/components/content/ComponentPreview.vue"),
      "utf8",
    );

    expect(preview).toContain('import.meta.glob("./examples/*.vue")');
    expect(preview).toContain('query: "?raw"');
    expect(preview).toContain("Live example");
    expect(preview).toContain('class="component-preview-source border-t border-default"');
    expect(preview).not.toContain('role="tablist"');
    expect(preview).not.toContain('role="tab"');
    // The source highlights once on the server and reaches the client in the payload.
    expect(preview).toContain('highlightCodeLines(source, "vue")');
    expect(preview).toContain('<ProsePre language="vue" :code="source"');
    expect(preview).toContain('@click="copy(source)"');
    expect(preview).toContain('<component :is="example" :key="resetKey" />');
    expect(preview).not.toContain("<code>{{ source }}</code>");
  });

  it("loads previews through the public Nuxt module", () => {
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const manifest = readFileSync(resolve(docsRoot, "package.json"), "utf8");
    const docsModule = readFileSync(resolve(packageRoot, "src/nuxt.ts"), "utf8");

    // The docs module installs the UI module, so the site lists only the docs module.
    expect(config).toContain('"@vite-hub/docs/nuxt"');
    expect(docsModule).toContain('[dependency("@vite-hub/ui/nuxt")]: {}');
    expect(manifest).toContain('"@vite-hub/ui": "workspace:*"');
  });

  it("gives component pages the shared article layout and page outline", () => {
    const page = readFileSync(resolve(packageApp, "components/DocsPage.vue"), "utf8");
    const article = readFileSync(resolve(packageApp, "components/DocsArticle.vue"), "utf8");
    expect(page).toContain('<DocsArticle :response="response" />');
    expect(article).toContain('<DocsMarkdown :document="response.document" :components="{ pre: DocsCodePre }" />');
    expect(article).toContain("UContentToc");
    expect(article).toContain('v-if="tocLinks.length"');
    expect(article).toContain('aria-label="Page outline"');
    expect(article).toContain("min-w-0");
    expect(article).toContain("max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 6rem)");
  });

  it("uses the wide component layout without the desktop outline", () => {
    const page = readFileSync(resolve(packageApp, "components/DocsPage.vue"), "utf8");
    const layout = readFileSync(resolve(packageApp, "layouts/docs.vue"), "utf8");

    expect(page).toContain('<DocsArticle :response="response" />');
    expect(page).toContain("vh-docs-main");
    expect(layout).toContain("lg:!flex lg:!flex-row");
  });

  it("keeps only search in the panel head, without a product context link or disclosure control", () => {
    const sidebarTop = readFileSync(resolve(packageApp, "components/DocsAsideLeftTop.vue"), "utf8");

    expect(sidebarTop).toContain("<UContentSearchButton");
    expect(sidebarTop).not.toContain("vh-docs-context");
    expect(sidebarTop).not.toContain("USelectMenu");
    expect(sidebarTop).not.toContain("getDocsSectionSelectItems");
  });

  it("moves the brand, the site areas, and the controls from the header into the sidebar", () => {
    const rail = readFileSync(resolve(packageApp, "components/DocsRail.vue"), "utf8");
    const body = readFileSync(resolve(packageApp, "components/DocsAsideLeftBody.vue"), "utf8");
    const sidebars = readFileSync(resolve(packageApp, "components/DocsSidebars.vue"), "utf8");
    const footer = readFileSync(resolve(packageApp, "components/DocsAsideFooter.vue"), "utf8");
    const header = readFileSync(resolve(packageApp, "components/AppHeader.vue"), "utf8");
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");

    // The rail names the site and its badge from the `docs.site` options: "ViteHub navigation" and "ViteHub alpha".
    expect(rail).toContain('<PrimitiveRail ref="rail" :label="`${site.name} navigation`"');
    expect(rail).toContain("const brand = site.badge ? `${site.name} ${site.badge.label}` : site.name");
    expect(rail).toContain('<PrimitiveRailItem :as="NuxtLink" to="/" :label="brand" class="vh-docs-rail-brand">');
    expect(rail).toContain("<template #label>");
    expect(body).toContain('v-for="link in startLinks"');
    expect(config).toContain('{ label: "Tutorials", to: "/tutorials"');
    expect(config).toContain('{ label: "Projects", to: "/projects"');
    expect(config).toContain('{ label: "Templates", to: "/templates"');
    expect(sidebars).toContain("<DocsAsideFooter />");
    expect(footer).toContain("<UColorModeButton");
    expect(footer).toContain('v-for="link in socials"');
    expect(config).toContain('socials: [{ label: "ViteHub on Discord"');
    // The header stays for the menu on narrow screens and hides where the sidebar shows.
    expect(header).toContain(":class=\"{ 'lg:hidden': isDocsRoute }\"");
  });

  it("keeps the docs sidebar visible without disclosure toggles", () => {
    const sidebar = readFileSync(resolve(packageApp, "components/DocsAsideLeftBody.vue"), "utf8");
    const layout = readFileSync(resolve(packageApp, "layouts/docs.vue"), "utf8");
    const sidebarPanel = readFileSync(resolve(packageApp, "components/DocsSidebars.vue"), "utf8");

    expect(sidebar).toContain("flex: 1 1 0");
    expect(sidebar).toContain("min-height: 0");
    expect(sidebar).not.toContain("<details");
    expect(sidebar).not.toContain("<summary");
    expect(layout).toContain("UPageAside class=\"vh-docs-aside hidden lg:flex\"");
    expect(layout).toContain('<DocsSidebars class="vh-docs-aside-sidebars" panel />');
    expect(layout).toContain("height: calc(100dvh - var(--ui-header-height));");
    // The aside container is a flex column. The sidebars must grow into it, or the panel collapses to its header.
    const desktopStyles = layout.slice(layout.indexOf("@media (min-width: 64rem)"));
    expect(desktopStyles).toMatch(/\.vh-docs-aside-sidebars\s*\{[^}]*flex: 1 1 0;/);
    expect(sidebarPanel).toContain("overflow: hidden;");
    expect(layout).toContain("overflow: hidden;");
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
