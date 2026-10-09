import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

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
    expect(codeBlocks(page, label), `${pagePath} should include ${label}`).toContain(expected);
  }
}

describe("documentation tutorials", () => {
  it("uses the framework distribution as the only direct ViteHub dependency", async () => {
    for (const fixture of ["agents", "server-primitives"]) {
      const manifest = JSON.parse(
        await readFile(resolve(fixturesRoot, fixture, "package.json"), "utf8"),
      );
      const dependencyNames = Object.keys(manifest.dependencies || {});

      expect(dependencyNames).toContain("vite-hub");
      expect(dependencyNames.filter((name) => name.startsWith("@vite-hub/"))).toEqual([]);
    }
  });

  it("gives every product a tutorial with runnable steps", async () => {
    const docs = resolve(docsRoot, "content/docs");
    const entries = await readdir(docs, { withFileTypes: true });
    const tutorialPaths: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = resolve(docs, entry.name, "get-started.md");
      try {
        await readFile(path);
        tutorialPaths.push(path);
      } catch {
        // Some sections, such as Reference, intentionally have no package tutorial.
      }
    }

    expect(tutorialPaths.length).toBeGreaterThanOrEqual(19);

    for (const path of tutorialPaths) {
      const source = await readFile(path, "utf8");
      expect(source, path).toContain("layout: tutorial");
      expect(source, path).toContain("navigation.title: Tutorial");
      expect(source, path).toContain("::tutorial-step");
      expect(source.match(/```[^\n]*\[[^\]]+\]/g)?.length || 0, path).toBeGreaterThan(0);
    }
  });

  it("covers public packages that live outside a primitive section", async () => {
    for (const page of [
      "content/docs/ui/get-started.md",
      "content/docs/agents/box-tutorial.md",
      "content/docs/reference/markdown-template-tutorial.md",
    ]) {
      const source = await readFile(resolve(docsRoot, page), "utf8");
      expect(source, page).toContain("layout: tutorial");
      expect(source, page).toContain(
        page.endsWith("agents/box-tutorial.md")
          ? "navigation.title: Box tutorial"
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

  it("lists product tutorials through the Guides page", async () => {
    const source = await readFile(resolve(docsRoot, "app/pages/guides.vue"), "utf8");

    expect(source).toContain("docsManifest.sections.flatMap");
    expect(source).toContain('page.layout === "tutorial"');
    expect(source).toContain("to: page.path");
    expect(source).toContain("<UBlogPosts");
    expect(source).toContain("<UBlogPost");
  });

  it("keeps the standalone quickstarts on their checked fixtures", async () => {
    await expectPageToUseFixture(
      "content/docs/getting-started/first-server-primitive.md",
      "server-primitives",
      ["vite.config.ts", "src/server.ts"],
    );
    await expectPageToUseFixture("content/docs/getting-started/first-agent.md", "first-agent", [
      "vite.config.ts",
      "server/agents/greeting.ts",
      "src/server.ts",
    ]);
  });

  it("initializes every standalone tutorial as an ESM package", async () => {
    for (const page of [
      "content/docs/getting-started/first-server-primitive.md",
      "content/docs/getting-started/first-agent.md",
    ]) {
      const source = await readFile(resolve(docsRoot, page), "utf8");
      expect(source, `${page} should configure Node.js to load the built server as ESM`).toContain(
        "pnpm pkg set type=module",
      );
    }
  });
});
