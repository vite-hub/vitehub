import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { docsManifest, getDocsPage } from "../modules/vitehub-docs/runtime/utils/docs";
import { getShowcaseExamples, getShowcaseFiles, getShowcasePhasePaths } from "../modules/vitehub-docs/runtime/utils/showcase";

describe("showcase examples", () => {
  it("loads generated examples from the docs manifest", () => {
    const examples = getShowcaseExamples();
    const kv = examples.find(example => example.docsPath === "kv");

    expect(kv?.label).toBe("KV");
    expect(docsManifest.examples.length).toBeGreaterThan(0);
  });

  it("returns the phase paths for the selected framework and mode", () => {
    const kv = getShowcaseExamples().find(example => example.docsPath === "kv");
    expect(kv).toBeTruthy();

    const phases = getShowcasePhasePaths(kv!, "vite", "build");
    expect(phases.configure).toBe("vite.config.ts");
    expect(phases.run).toBe("src/main.ts");
  });

  it("keeps phase files first for the selected framework and mode", () => {
    const kv = getShowcaseExamples().find(example => example.docsPath === "kv");
    expect(kv).toBeTruthy();

    const files = getShowcaseFiles(kv!, "vite", "build");
    expect(files.slice(0, 3).map(file => file.path)).toEqual(["vite.config.ts", "src/main.ts", "package.json"]);
    expect(files.some(file => file.path === "src/main.ts")).toBe(true);
  });

  it("keeps nitro showcase files in manifest order", () => {
    const kv = getShowcaseExamples().find(example => example.docsPath === "kv");
    expect(kv).toBeTruthy();

    const phases = getShowcasePhasePaths(kv!, "nitro", "build");
    expect(phases.run).toBe("server/api/settings.get.ts");

    const files = getShowcaseFiles(kv!, "nitro", "build");
    expect(files.slice(0, 5).map(file => file.path)).toEqual([
      "nitro.config.ts",
      "server/api/settings.get.ts",
      "server/api/settings.put.ts",
      "server/api/settings.delete.ts",
      "package.json",
    ]);
    expect(files.some(file => file.path.startsWith("server/api/tests/"))).toBe(false);
  });

  it("keeps nuxt showcase files in manifest order", () => {
    const kv = getShowcaseExamples().find(example => example.docsPath === "kv");
    expect(kv).toBeTruthy();

    const phases = getShowcasePhasePaths(kv!, "nuxt", "build");
    expect(phases.run).toBe("server/api/settings.get.ts");

    const files = getShowcaseFiles(kv!, "nuxt", "build");
    expect(files.slice(0, 5).map(file => file.path)).toEqual([
      "nuxt.config.ts",
      "server/api/settings.get.ts",
      "server/api/settings.put.ts",
      "server/api/settings.delete.ts",
      "package.json",
    ]);
  });

  it("normalizes example package manifests for display", () => {
    const kv = getShowcaseExamples().find(example => example.docsPath === "kv");
    expect(kv).toBeTruthy();

    const packageFile = getShowcaseFiles(kv!, "nitro", "build").find(file => file.path === "package.json");
    expect(packageFile).toBeTruthy();

    expect(packageFile!.code).not.toContain("\"private\": true");
    expect(packageFile!.code).not.toContain("workspace:*");
    expect(packageFile!.code).not.toContain("catalog:");
    expect(packageFile!.code).toContain("\"@vitehub/kv\": \"0.0.0\"");
    expect(packageFile!.code).toContain("\"nitro\": \"3.0.260311-beta\"");
  });

  it("applies provider overrides without changing showcase ordering", () => {
    const kv = getShowcaseExamples().find(example => example.docsPath === "kv");
    expect(kv).toBeTruthy();

    const files = getShowcaseFiles(kv!, "vite", "upstash");
    expect(files.slice(0, 2).map(file => file.path)).toEqual(["vite.config.ts", "src/main.ts"]);
    expect(files.find(file => file.path === "vite.config.ts")?.code).toContain("driver: 'upstash'");
    expect(files.find(file => file.path === "env.example")?.code).toContain("KV_REST_API_URL=https://example.upstash.io");
  });

  it("loads the queue example for vite and nitro only", () => {
    const queue = getShowcaseExamples().find(example => example.docsPath === "queue");
    expect(queue).toBeTruthy();

    expect(queue?.label).toBe("Queue");
    expect(queue?.frameworks.vite).toBeTruthy();
    expect(queue?.frameworks.nitro).toBeTruthy();
    expect(queue?.frameworks.nuxt).toBeFalsy();
  });

  it("returns queue phase paths for supported frameworks", () => {
    const queue = getShowcaseExamples().find(example => example.docsPath === "queue");
    expect(queue).toBeTruthy();

    expect(getShowcasePhasePaths(queue!, "vite", "build")).toEqual({
      configure: "vite.config.ts",
      define: "src/welcome-email.queue.ts",
      run: "src/main.ts",
    });
    expect(getShowcasePhasePaths(queue!, "nitro", "build")).toEqual({
      configure: "nitro.config.ts",
      define: "server/queues/welcome-email.ts",
      run: "server/api/queues/welcome.post.ts",
    });
  });

  it("keeps queue showcase files ordered by phase and supplemental files", () => {
    const queue = getShowcaseExamples().find(example => example.docsPath === "queue");
    expect(queue).toBeTruthy();

    expect(getShowcaseFiles(queue!, "vite", "build").slice(0, 5).map(file => file.path)).toEqual([
      "vite.config.ts",
      "src/welcome-email.queue.ts",
      "src/main.ts",
      "index.html",
      "package.json",
    ]);

    expect(getShowcaseFiles(queue!, "nitro", "build").slice(0, 6).map(file => file.path)).toEqual([
      "nitro.config.ts",
      "server/queues/welcome-email.ts",
      "server/api/queues/welcome.post.ts",
      "server/api/queues/welcome-defer.post.ts",
      "server/api/tests/probe.get.ts",
      "package.json",
    ]);
  });

  it("includes a providers overview page in the docs manifest", () => {
    const providers = docsManifest.sections.find(section => section.id === "providers");

    expect(providers?.pages.some(page => page.id === "index")).toBe(true);
  });

  it("links provider overview pages to generated provider docs", () => {
    expect(getDocsPage("kv", "providers/cloudflare")).toBeTruthy();
    expect(getDocsPage("kv", "providers/vercel")).toBeTruthy();
    expect(getDocsPage("queue", "providers/cloudflare")).toBeTruthy();
    expect(getDocsPage("queue", "providers/vercel")).toBeTruthy();

    const gettingStarted = readFileSync(resolve(import.meta.dirname, "../content/docs/getting-started/index.md"), "utf8");
    const cloudflare = readFileSync(resolve(import.meta.dirname, "../content/docs/providers/cloudflare.md"), "utf8");
    const vercel = readFileSync(resolve(import.meta.dirname, "../content/docs/providers/vercel.md"), "utf8");

    expect(gettingStarted).toContain("to: ../queue");
    expect(gettingStarted).toContain("to: ../queue/quickstart");
    expect(gettingStarted).not.toContain("/docs/nitro/queue");
    expect(cloudflare).toContain("../kv/providers/cloudflare");
    expect(cloudflare).not.toContain("../kv/cloudflare");
    expect(cloudflare).toContain("../queue/providers/cloudflare");
    expect(cloudflare).not.toContain("/docs/nitro/queue/providers/cloudflare");
    expect(vercel).toContain("../kv/providers/vercel");
    expect(vercel).not.toContain("../kv/vercel");
    expect(vercel).toContain("../queue/providers/vercel");
    expect(vercel).not.toContain("/docs/nitro/queue/providers/vercel");
  });
});
