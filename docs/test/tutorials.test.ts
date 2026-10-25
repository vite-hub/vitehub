import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const docsRoot = resolve(import.meta.dirname, "..");
const fixturesRoot = resolve(docsRoot, "../fixtures/tutorials");

function normalize(source: string) {
  return source.trim().replaceAll("\r\n", "\n");
}

function codeBlocks(source: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("```[^\\n]*\\[" + escaped + "\\]\\n([\\s\\S]*?)\\n```", "g");

  return [...source.matchAll(pattern)].map((match) => normalize(match[1] || ""));
}

async function expectPageToUseFixture(pagePath: string, fixture: string, labels: string[]) {
  const page = await readFile(resolve(docsRoot, pagePath), "utf8");

  for (const label of labels) {
    const expected = normalize(await readFile(resolve(fixturesRoot, fixture, label), "utf8"));
    expect(codeBlocks(page, label), `${pagePath} should include ${label}`).toEqual([expected]);
  }
}

describe("documentation tutorials", () => {
  it("uses the framework distribution as the only direct ViteHub dependency", async () => {
    for (const fixture of ["agents", "first-agent", "server-primitives"]) {
      const manifest = JSON.parse(
        await readFile(resolve(fixturesRoot, fixture, "package.json"), "utf8"),
      );
      const dependencyNames = Object.keys(manifest.dependencies || {});

      expect(dependencyNames).toContain("vite-hub");
      expect(dependencyNames.filter((name) => name.startsWith("@vite-hub/"))).toEqual([]);
    }
  });

  it("gives every Server Primitive and UI section a tutorial with runnable steps", async () => {
    const docs = resolve(docsRoot, "content/docs");
    const entries = await readdir(docs, { withFileTypes: true });
    const tutorialPaths: string[] = [];
    const primitiveCategories = new Set(["Data", "Compute", "Access", "Delivery", "Files"]);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const navigation: unknown = parse(await readFile(resolve(docs, entry.name, ".navigation.yml"), "utf8"));
      const isPrimitive = navigation !== null && typeof navigation === "object"
        && "category" in navigation && typeof navigation.category === "string"
        && primitiveCategories.has(navigation.category);
      if (entry.name !== "ui" && !isPrimitive) continue;
      tutorialPaths.push(resolve(docs, entry.name, "get-started.md"));
    }

    expect(tutorialPaths.length).toBeGreaterThanOrEqual(19);

    for (const path of tutorialPaths) {
      const source = await readFile(path, "utf8");
      expect(source, path).toContain("layout: tutorial");
      expect(source, path).toMatch(/navigation\.title: (?:Get started|Tutorial)/);
      expect(source, path).toContain("::tutorial-step");
      expect(source.match(/```[^\n]*\[[^\]]+\]/g)?.length || 0, path).toBeGreaterThan(0);
    }
  });

  it("routes the Agent learning path through the canonical first Agent and chat tutorials", async () => {
    const source = await readFile(resolve(docsRoot, "content/docs/agents/get-started.md"), "utf8");

    expect(source).toContain("navigation.title: Learning path");
    expect(source).not.toContain("layout: tutorial");
    expect(source).toContain("(/docs/getting-started/first-agent)");
    expect(source).toContain("(/docs/agents/build-a-chat-app)");
  });

  it("covers public packages that live outside a primitive section", async () => {
    for (const page of [
      "content/docs/ui/get-started.md",
      "content/docs/agents/sandbox-tutorial.md",
      "content/docs/reference/markdown-template-tutorial.md",
    ]) {
      const source = await readFile(resolve(docsRoot, page), "utf8");
      expect(source, page).toContain("layout: tutorial");
      expect(source, page).toContain(
        page.endsWith("agents/sandbox-tutorial.md")
          ? "navigation.title: Sandbox tutorial"
          : "navigation.title: Tutorial",
      );
      expect(source, page).toContain("::tutorial-step");
      expect(source.match(/```[^\n]*\[[^\]]+\]/g)?.length || 0, page).toBeGreaterThan(0);
    }
  });

  it("keeps tutorial code inline at every viewport width", async () => {
    const tutorial = await readFile(resolve(docsRoot, "app/components/DocsTutorial.vue"), "utf8");
    const step = await readFile(resolve(docsRoot, "app/components/TutorialStep.vue"), "utf8");

    expect(tutorial).toContain('<DocsArticle :page="page" tutorial />');
    expect(step).toContain("<slot />");
    expect(step).not.toContain("display: none");
    expect(step).not.toContain("CodeTreeIntersection");
    expect(step).not.toContain("min-height: 30rem");
    expect(step).toContain("counter-increment: tutorial-step");
  });

  it("shares a page outline and reading measure with regular docs", async () => {
    const article = await readFile(resolve(docsRoot, "app/components/DocsArticle.vue"), "utf8");

    expect(article).toContain('aria-label="Page outline"');
    expect(article).toContain('title="On this page"');
    expect(article).toContain("props.page.body?.toc?.links");
    expect(article).toContain("margin-inline: auto");
    expect(article).toContain("counter-reset: tutorial-step");
  });

  it("remounts the tutorial steps when navigating between packages", async () => {
    const source = await readFile(resolve(docsRoot, "app/pages/docs/[...slug].vue"), "utf8");
    expect(source).toContain(
      '<DocsTutorial v-else-if="page && isTutorialPage" :key="page.path" :page="page" />',
    );
  });

  it("lists product tutorials through the top-level Tutorials page", async () => {
    const source = await readFile(resolve(docsRoot, "app/pages/tutorials.vue"), "utf8");
    const catalog = await readFile(resolve(docsRoot, "app/components/TutorialCatalog.vue"), "utf8");

    expect(catalog).toContain("docsManifest.sections.flatMap");
    expect(catalog).toContain('page.layout === "tutorial"');
    expect(catalog).toContain("to: page.path");
    expect(catalog).toContain("<UBlogPosts");
    expect(catalog).toContain("<UBlogPost");
    expect(source).toContain("<TutorialCatalog />");
  });

  it("redirects the old Guides path to the Tutorials index", async () => {
    const source = await readFile(resolve(docsRoot, "app/pages/guides.vue"), "utf8");

    expect(source).toContain('navigateTo("/tutorials", { redirectCode: 301 })');
  });

  it("keeps the first tutorials on their Nitro fixtures", async () => {
    await expectPageToUseFixture(
      "content/docs/getting-started/first-server-primitive.md",
      "server-primitives",
      ["vite.config.ts", "server/api/settings.post.ts"],
    );
    await expectPageToUseFixture("content/docs/getting-started/first-agent.md", "first-agent", [
      "vite.config.ts",
      "server/agents/greeting.ts",
      "server/api/greet.post.ts",
    ]);
  });

  it.each(["first-agent", "server-primitives"])("inherits Installation's ESM server setup in %s", async (fixture) => {
    const installation = await readFile(resolve(docsRoot, "content/docs/getting-started/installation.md"), "utf8");
    const manifests = codeBlocks(installation, "package.json");
    expect(manifests).toHaveLength(1);
    const setup = JSON.parse(manifests[0]!);
    const manifest = JSON.parse(await readFile(resolve(fixturesRoot, fixture, "package.json"), "utf8"));

    expect(setup.type).toBe("module");
    expect(manifest.type).toBe(setup.type);
    expect(setup.scripts).toMatchObject({
      dev: "vite --port 3000 --strictPort",
      build: "vite build",
      start: "node .output/server/index.mjs",
    });
    expect(manifest.scripts).toMatchObject(setup.scripts);
    expect(Object.keys(manifest.dependencies)).toEqual(expect.arrayContaining(["vite-hub", "vite", "nitro", "h3"]));

    await expectPageToUseFixture("content/docs/getting-started/installation.md", fixture, [
      "server/api/health.get.ts",
      "tsconfig.json",
    ]);
  });

  it("continues both first tutorials in the app from Installation", async () => {
    for (const page of [
      "content/docs/getting-started/first-server-primitive.md",
      "content/docs/getting-started/first-agent.md",
    ]) {
      const source = await readFile(resolve(docsRoot, page), "utf8");
      expect(source, page).toContain("[Installation](/docs/getting-started/installation)");
      expect(codeBlocks(source, "commands/dev"), page).toEqual(["pnpm dev"]);
      expect(codeBlocks(source, "commands/build"), page).toEqual(["pnpm build\npnpm start"]);
    }
  });
});
