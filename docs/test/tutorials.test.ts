import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { buildRunnableTutorial, frameworkView, readWorkspaceVersions, resolveManifest, tutorialStepFiles } from "../modules/tutorials/build";
import { runnableTutorials } from "../modules/tutorials/list";
import { restartsDevServer, tutorialWorkspaceFiles } from "../modules/tutorials/steps";
import { frameworkNodes, parseCurl, splitTutorialDocument } from "../app/utils/runnable-tutorial";

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
  const page = frameworkView(await readFile(resolve(docsRoot, pagePath), "utf8"), "Vite");

  for (const label of labels) {
    const expected = normalize(await readFile(resolve(fixturesRoot, fixture, label), "utf8"));
    expect(codeBlocks(page, label), `${pagePath} should include ${label}`).toEqual([expected]);
  }
}

describe("documentation tutorials", () => {
  it("adds only the owner packages of opt-in features next to the framework distribution", async () => {
    for (const [fixture, owners] of [
      ["agents", ["@vite-hub/agent", "@vite-hub/workflow"]],
      ["first-agent", ["@vite-hub/agent"]],
      ["server-primitives", ["@vite-hub/kv"]],
      ["decisions", ["@vite-hub/decisions", "@vite-hub/gateways"]],
      ["playground-blob", ["@vite-hub/blob"]],
      ["playground-cache", []],
      ["playground-queue", ["@vite-hub/queue"]],
      ["playground-rate-limit", ["@vite-hub/rate-limit"]],
    ] as const) {
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
      ["content/docs/ui/chat-tutorial.md", "Chat tutorial"],
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

  it("redirects the old Guides path to Learn", async () => {
    const source = await readFile(resolve(docsRoot, "app/pages/guides.vue"), "utf8");

    expect(source).toContain('navigateTo("/learn", { redirectCode: 301 })');
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

  it("keeps the Decisions tutorial on its fixture", async () => {
    await expectPageToUseFixture("content/docs/decisions/get-started.md", "decisions", [
      "server/utils/word-gateway.ts",
      "server/utils/forecast-choices.ts",
      "server/api/choices.post.ts",
      "vite.config.ts",
      "index.html",
      "src/main.ts",
      "src/App.vue",
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
    const installation = frameworkView(await readFile(resolve(docsRoot, "content/docs/getting-started/installation.md"), "utf8"), "Vite");

    // The docs page links to this copy, and the steps are the page's steps.
    expect(lesson).toContain(`::run-tutorial{to="/learn/${slug}"}`);
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

  it.each(runnableTutorials.map((tutorial, index) => [tutorial.slug, index] as const))("resets files opened before %s creates them, preserving reader additions", async (_slug, index) => {
    const tutorial = await build(index);
    const start = tutorialStepFiles(tutorial, 0, "start");
    const solution = tutorialStepFiles(tutorial, tutorial.steps.length - 1, "solution");
    const created = Object.keys(solution).filter(path => !(path in start));
    expect(created.length).toBeGreaterThan(0);

    // "Show in editor" opens these tutorial files empty before they belong to the baseline.
    const current = { ...start, ...Object.fromEntries(created.map(path => [path, ""])), "reader-notes.txt": "Keep these notes" };
    expect(tutorialWorkspaceFiles(tutorial, current, start)).toEqual({ ...start, "reader-notes.txt": "Keep these notes" });

    // Loading any step must also restore its state, whether or not the old baseline owned the opened files.
    for (let step = 0; step < tutorial.steps.length; step++) {
      const target = tutorialStepFiles(tutorial, step, "start");
      expect(tutorialWorkspaceFiles(tutorial, current, target)).toEqual({ ...target, "reader-notes.txt": "Keep these notes" });
    }
    expect(tutorialWorkspaceFiles(tutorial, current, solution)).toEqual({ ...solution, "reader-notes.txt": "Keep these notes" });
  });

  it.each(runnableTutorials.map((tutorial, index) => [tutorial.slug, index] as const))("removes later %s files when loading an earlier step after Keep mine", async (_slug, index) => {
    const tutorial = await build(index);
    const current = { ...tutorialStepFiles(tutorial, tutorial.steps.length - 1, "solution"), "reader-notes.txt": "Keep these notes" };
    const target = tutorialStepFiles(tutorial, 0, "start");

    // "Keep mine" can change the baseline to an earlier step without changing the workspace files.
    expect(tutorialWorkspaceFiles(tutorial, current, target)).toEqual({ ...target, "reader-notes.txt": "Keep these notes" });
  });

  it("restarts the dev server when a step adds or removes the page, not for config edits", async () => {
    const tutorial = await build(runnableTutorials.findIndex(item => item.slug === "decisions"));
    const pageStep = tutorial.steps.findIndex(step => "index.html" in step.files);
    const before = tutorialStepFiles(tutorial, pageStep, "start");
    const after = tutorialStepFiles(tutorial, pageStep, "solution");

    // Nitro finds `index.html` only when its process starts. Vite restarts on its own for `vite.config.ts`.
    expect(restartsDevServer(before, after)).toBe(true);
    expect(restartsDevServer(after, before)).toBe(true);
    expect(restartsDevServer(after, { ...after, "index.html": "<!doctype html>" })).toBe(false);
    expect(restartsDevServer(before, { ...before, "vite.config.ts": after["vite.config.ts"]! })).toBe(false);
  });

  it("installs from npm, not from this repository", async () => {
    const manifest = JSON.parse((await build(1)).files["package.json"]!);
    const specifiers = Object.values({ ...manifest.dependencies, ...manifest.devDependencies }) as string[];
    expect(specifiers.filter(specifier => /^(?:catalog|workspace):/.test(specifier))).toEqual([]);
    expect(manifest.dependencies["vite-hub"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(() => resolveManifest(JSON.stringify({ dependencies: { missing: "catalog:none" } }), { catalogs: {}, packages: {} })).toThrow(/pnpm catalog/);
  });

  it("splits the lesson into its steps", () => {
    const parts = splitTutorialDocument(["intro", ["tutorial-step", { title: "One" }], "between", ["tutorial-step", { title: "Two" }], "outro"]);
    expect(parts).toEqual({ intro: ["intro"], steps: [["tutorial-step", { title: "One" }], ["tutorial-step", { title: "Two" }]], outro: ["outro"] });
  });

  it("shows the Vite tab of a framework tabs block in a runnable lesson", () => {
    expect(frameworkNodes([["tutorial-step", { title: "One" },
      ["tabs", { sync: "framework" },
        ["tabs-item", { label: "Nuxt" }, ["pre", { filename: "nuxt.config.ts" }]],
        ["tabs-item", { label: "Nitro" }, ["pre", { filename: "vite.config.ts" }, "nitro"]],
        ["tabs-item", { label: "Vite" }, ["pre", { filename: "vite.config.ts" }, "vite"]]],
      ["tabs", { sync: "os" }, ["tabs-item", { label: "macOS" }, "mac"]]]], "Vite")).toEqual([
      ["tutorial-step", { title: "One" }, ["pre", { filename: "vite.config.ts" }, "vite"], ["tabs", { sync: "os" }, ["tabs-item", { label: "macOS" }, "mac"]]],
    ]);
  });

  it("runs the request blocks of a lesson, and nothing else", () => {
    expect(parseCurl(`curl -X POST http://localhost:3000/api/greet \\
  -H 'content-type: application/json' \\
  -d '{"name":"Ada"}'`)).toEqual({ method: "POST", url: "http://localhost:3000/api/greet", headers: { "content-type": "application/json" }, body: '{"name":"Ada"}' });
    expect(parseCurl("curl http://localhost:3000/api/health")).toMatchObject({ method: "GET" });
    expect(parseCurl("curl https://example.com")).toBeUndefined();
    expect(parseCurl("pnpm dev")).toBeUndefined();
  });

  it("isolates only the tutorial pages and the playground", async () => {
    const module = await readFile(resolve(docsRoot, "modules/tutorials/index.ts"), "utf8");
    expect(module).toContain(`"/learn": { headers: { ...webContainerHeaders } }`);
    expect(module).toContain(`"/learn/**": { headers: { ...webContainerHeaders } }`);
    expect(module).toContain(`"/playground": { headers: { ...webContainerHeaders } }`);
    expect(module.match(/headers: \{ \.\.\.webContainerHeaders \}/g)).toHaveLength(3);
  });
});
