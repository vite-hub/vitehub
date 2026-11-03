import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { buildRunnableTutorial, createZip, readWorkspaceVersions, resolveManifest, tutorialStepFiles } from "../modules/tutorials/build";
import { runnableTutorials } from "../modules/tutorials/list";
import { parseCurl, splitTutorialDocument } from "../app/utils/runnable-tutorial";

const docsRoot = resolve(import.meta.dirname, "..");
const fixturesRoot = resolve(docsRoot, "../fixtures/tutorials");
// The shared docs shell, including the tutorial layout, ships with @vite-hub/docs.
const packageApp = resolve(docsRoot, "../packages/docs/runtime/app");

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
  it("adds only the owner packages of opt-in features next to the framework distribution", async () => {
    for (const [fixture, owners] of [["agents", ["@vite-hub/agent"]], ["first-agent", ["@vite-hub/agent"]], ["server-primitives", []]] as const) {
      const manifest = JSON.parse(
        await readFile(resolve(fixturesRoot, fixture, "package.json"), "utf8"),
      );
      const dependencyNames = Object.keys(manifest.dependencies || {});

      expect(dependencyNames).toContain("vite-hub");
      expect(dependencyNames.filter((name) => name.startsWith("@vite-hub/"))).toEqual(owners);
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
    for (const [page, title] of [
      ["content/docs/ui/get-started.md", "Get started"],
      ["content/docs/agents/sandbox-tutorial.md", "Sandbox tutorial"],
      ["content/docs/reference/markdown-template-tutorial.md", "Tutorial"],
    ]) {
      const source = await readFile(resolve(docsRoot, page), "utf8");
      expect(source, page).toContain("layout: tutorial");
      expect(source, page).toContain(`navigation.title: ${title}`);
      expect(source, page).toContain("::tutorial-step");
      expect(source.match(/```[^\n]*\[[^\]]+\]/g)?.length || 0, page).toBeGreaterThan(0);
    }
  });

  it("keeps tutorial code inline at every viewport width", async () => {
    const page = await readFile(resolve(packageApp, "components/DocsPage.vue"), "utf8");
    const step = await readFile(resolve(packageApp, "components/content/TutorialStep.vue"), "utf8");

    expect(page).toContain('<DocsArticle :response="response" />');
    expect(step).toContain("<slot />");
    expect(step).not.toContain("display: none");
    expect(step).not.toContain("CodeTreeIntersection");
    expect(step).not.toContain("min-height: 30rem");
    expect(step).toContain("counter-increment: tutorial-step");
  });

  it("shares a page outline and reading measure with regular docs", async () => {
    const article = await readFile(resolve(packageApp, "components/DocsArticle.vue"), "utf8");

    expect(article).toContain('aria-label="Page outline"');
    expect(article).toContain('title="On this page"');
    expect(article).toContain("props.response.document.toc");
    expect(article).toContain("margin-inline: auto");
    expect(article).toContain("counter-reset: tutorial-step");
  });

  it("remounts the tutorial steps when navigating between packages", async () => {
    const source = await readFile(resolve(packageApp, "components/DocsPage.vue"), "utf8");
    expect(source).toContain(":key=\"page.layout === 'tutorial' ? page.path : undefined\"");
  });

  it("lists product tutorials through the top-level Tutorials page", async () => {
    const source = await readFile(resolve(docsRoot, "app/pages/tutorials/index.vue"), "utf8");
    const catalog = await readFile(resolve(docsRoot, "app/components/TutorialCatalog.vue"), "utf8");

    expect(catalog).toContain("useDocsManifest().sections.flatMap");
    expect(catalog).toContain('page.layout === "tutorial"');
    expect(catalog).toContain("`/tutorials/${runnable.get(page.path)!.slug}` : page.path");
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

describe("runnable tutorials", () => {
  const repoRoot = resolve(docsRoot, "..");
  const build = async (index: number) => buildRunnableTutorial({
    source: runnableTutorials[index]!,
    contentDir: resolve(docsRoot, "content"),
    fixturesDir: fixturesRoot,
    versions: await readWorkspaceVersions(repoRoot),
  });

  it.each(runnableTutorials.map((tutorial, index) => [tutorial.slug, index] as const))("builds %s from its lesson and its fixture", async (slug, index) => {
    const tutorial = await build(index);
    const lesson = await readFile(resolve(docsRoot, `content${tutorial.page}.md`), "utf8");
    const installation = await readFile(resolve(docsRoot, "content/docs/getting-started/installation.md"), "utf8");

    // The docs page links to this copy, and the steps are the page's steps.
    expect(lesson).toContain(`::run-tutorial{to="/tutorials/${slug}"}`);
    expect(tutorial.steps.map(step => step.title)).toEqual([...lesson.matchAll(/^::tutorial-step\{title="([^"]+)"\}/gm)].map(match => match[1]));

    // Step 1 starts from the app of Installation. Every file code block of a step is the fixture file.
    expect(normalize(tutorial.files["vite.config.ts"]!)).toEqual(codeBlocks(installation, "vite.config.ts")[0]);
    for (const step of tutorial.steps) {
      for (const [path, contents] of Object.entries(step.files)) {
        expect(normalize(contents)).toEqual(normalize(await readFile(resolve(fixturesRoot, runnableTutorials[index]!.fixture, path), "utf8")));
      }
    }

    // The last solution is the whole fixture, so the workspace ends where `tutorial-fixture.test.ts` builds and runs.
    const final = tutorialStepFiles(tutorial, tutorial.steps.length - 1, "solution");
    for (const path of Object.keys(final)) {
      if (path === "package.json") continue;
      expect(normalize(final[path]!), path).toEqual(normalize(await readFile(resolve(fixturesRoot, runnableTutorials[index]!.fixture, path), "utf8")));
    }
    expect(tutorialStepFiles(tutorial, 1, "start")).toEqual(tutorialStepFiles(tutorial, 0, "solution"));
  });

  it("installs from npm, not from this repository", async () => {
    const manifest = JSON.parse((await build(1)).files["package.json"]!);
    const specifiers = Object.values({ ...manifest.dependencies, ...manifest.devDependencies }) as string[];
    expect(specifiers.filter(specifier => /^(?:catalog|workspace):/.test(specifier))).toEqual([]);
    expect(manifest.dependencies["vite-hub"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(() => resolveManifest(JSON.stringify({ dependencies: { missing: "catalog:none" } }), { catalogs: {}, packages: {} })).toThrow(/pnpm catalog/);
  });

  it("zips the starter with the files of step 1", async () => {
    const tutorial = await build(0);
    const zip = Buffer.from(createZip(tutorialStepFiles(tutorial, 0, "start"), tutorial.slug));
    expect(zip.subarray(0, 4).readUInt32LE(0)).toBe(0x04034B50);
    expect(zip.toString("latin1")).toContain("first-server-primitive/vite.config.ts");
    expect(zip.toString("latin1")).not.toContain("server/api/settings.post.ts");
  });

  it("splits the lesson into its steps", () => {
    const parts = splitTutorialDocument(["intro", ["tutorial-step", { title: "One" }], "between", ["tutorial-step", { title: "Two" }], "outro"]);
    expect(parts).toEqual({ intro: ["intro"], steps: [["tutorial-step", { title: "One" }], ["tutorial-step", { title: "Two" }]], outro: ["outro"] });
  });

  it("runs the request blocks of a lesson, and nothing else", () => {
    expect(parseCurl(`curl -X POST http://localhost:3000/api/greet \\
  -H 'content-type: application/json' \\
  -d '{"name":"Ada"}'`)).toEqual({ method: "POST", url: "http://localhost:3000/api/greet", headers: { "content-type": "application/json" }, body: '{"name":"Ada"}' });
    expect(parseCurl("curl http://localhost:3000/api/health")).toMatchObject({ method: "GET" });
    expect(parseCurl("curl https://example.com")).toBeUndefined();
    expect(parseCurl("pnpm dev")).toBeUndefined();
  });

  it("isolates only the tutorial pages", async () => {
    const module = await readFile(resolve(docsRoot, "modules/tutorials/index.ts"), "utf8");
    expect(module).toContain(`"/tutorials": { headers: { ...webContainerHeaders } }`);
    expect(module).toContain(`"/tutorials/**": { headers: { ...webContainerHeaders } }`);
    expect(module.match(/headers: \{ \.\.\.webContainerHeaders \}/g)).toHaveLength(2);
  });
});
