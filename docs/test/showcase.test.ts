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

  it("includes every generated package section in the package selector manifest", () => {
    const generatedPackageSections = docsManifest.sections
      .filter(section => section.source === "package")
      .map(section => ({ id: section.id, title: section.title, icon: section.icon }));

    expect(docsManifest.packageSections).toEqual(generatedPackageSections);
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

  it("loads the blob example for vite and nitro only", () => {
    const blob = getShowcaseExamples().find(example => example.docsPath === "blob");
    expect(blob).toBeTruthy();

    expect(blob?.label).toBe("Blob");
    expect(blob?.frameworks.vite).toBeTruthy();
    expect(blob?.frameworks.nitro).toBeTruthy();
    expect(blob?.frameworks.nuxt).toBeFalsy();
  });

  it("loads the sandbox example for vite and nitro only", () => {
    const sandbox = getShowcaseExamples().find(example => example.docsPath === "sandbox");
    expect(sandbox).toBeTruthy();

    expect(sandbox?.label).toBe("Sandbox");
    expect(sandbox?.frameworks.vite).toBeTruthy();
    expect(sandbox?.frameworks.nitro).toBeTruthy();
    expect(sandbox?.frameworks.nuxt).toBeFalsy();
  });

  it("returns queue phase paths for supported frameworks", () => {
    const queue = getShowcaseExamples().find(example => example.docsPath === "queue");
    expect(queue).toBeTruthy();

    expect(getShowcasePhasePaths(queue!, "vite", "build")).toEqual({
      configure: "vite.config.ts",
      define: "src/welcome-email.queue.ts",
      run: "src/server.ts",
    });
    expect(getShowcasePhasePaths(queue!, "nitro", "build")).toEqual({
      configure: "nitro.config.ts",
      define: "server/queues/welcome-email.ts",
      run: "server/api/welcome.post.ts",
    });
  });

  it("returns blob phase paths for supported frameworks", () => {
    const blob = getShowcaseExamples().find(example => example.docsPath === "blob");
    expect(blob).toBeTruthy();

    expect(getShowcasePhasePaths(blob!, "vite", "build")).toEqual({
      configure: "vite.config.ts",
      run: "src/server.ts",
    });
    expect(getShowcasePhasePaths(blob!, "nitro", "build")).toEqual({
      configure: "nitro.config.ts",
      run: "server/api/blob.get.ts",
    });
  });

  it("returns sandbox phase paths for supported frameworks", () => {
    const sandbox = getShowcaseExamples().find(example => example.docsPath === "sandbox");
    expect(sandbox).toBeTruthy();

    expect(getShowcasePhasePaths(sandbox!, "vite", "build")).toEqual({
      configure: "vite.config.ts",
      define: "src/release-notes.sandbox.ts",
      run: "src/server.ts",
    });
    expect(getShowcasePhasePaths(sandbox!, "nitro", "build")).toEqual({
      configure: "nitro.config.ts",
      define: "server/sandboxes/release-notes.ts",
      run: "server/api/release-notes.post.ts",
    });
  });

  it("keeps queue showcase files ordered by phase and supplemental files", () => {
    const queue = getShowcaseExamples().find(example => example.docsPath === "queue");
    expect(queue).toBeTruthy();

    expect(getShowcaseFiles(queue!, "vite", "build").slice(0, 4).map(file => file.path)).toEqual([
      "vite.config.ts",
      "src/welcome-email.queue.ts",
      "src/server.ts",
      "package.json",
    ]);

    expect(getShowcaseFiles(queue!, "nitro", "build").slice(0, 4).map(file => file.path)).toEqual([
      "nitro.config.ts",
      "server/queues/welcome-email.ts",
      "server/api/welcome.post.ts",
      "package.json",
    ]);
  });

  it("keeps blob showcase files ordered by phase and supplemental files", () => {
    const blob = getShowcaseExamples().find(example => example.docsPath === "blob");
    expect(blob).toBeTruthy();

    expect(getShowcaseFiles(blob!, "vite", "build").slice(0, 3).map(file => file.path)).toEqual([
      "vite.config.ts",
      "src/server.ts",
      "package.json",
    ]);

    expect(getShowcaseFiles(blob!, "nitro", "build").slice(0, 4).map(file => file.path)).toEqual([
      "nitro.config.ts",
      "server/api/blob.get.ts",
      "server/api/blob.put.ts",
      "package.json",
    ]);
  });

  it("keeps sandbox showcase files ordered by phase and supplemental files", () => {
    const sandbox = getShowcaseExamples().find(example => example.docsPath === "sandbox");
    expect(sandbox).toBeTruthy();

    expect(getShowcaseFiles(sandbox!, "vite", "build").slice(0, 4).map(file => file.path)).toEqual([
      "vite.config.ts",
      "src/release-notes.sandbox.ts",
      "src/server.ts",
      "package.json",
    ]);

    expect(getShowcaseFiles(sandbox!, "nitro", "build").slice(0, 4).map(file => file.path)).toEqual([
      "nitro.config.ts",
      "server/sandboxes/release-notes.ts",
      "server/api/release-notes.post.ts",
      "package.json",
    ]);
  });

  it("applies sandbox provider overrides without changing showcase ordering", () => {
    const sandbox = getShowcaseExamples().find(example => example.docsPath === "sandbox");
    expect(sandbox).toBeTruthy();

    const cloudflareFiles = getShowcaseFiles(sandbox!, "vite", "cloudflare");
    expect(cloudflareFiles.slice(0, 3).map(file => file.path)).toEqual([
      "vite.config.ts",
      "src/release-notes.sandbox.ts",
      "src/server.ts",
    ]);
    const cloudflareViteConfig = cloudflareFiles.find(file => file.path === "vite.config.ts")?.code;
    expect(cloudflareViteConfig).toContain("appType: 'custom'");
    expect(cloudflareViteConfig).toContain("input: new URL('src/server.ts', import.meta.url).pathname");
    expect(cloudflareViteConfig).toContain("provider: 'cloudflare'");

    const vercelFiles = getShowcaseFiles(sandbox!, "nitro", "vercel");
    expect(vercelFiles.slice(0, 3).map(file => file.path)).toEqual([
      "nitro.config.ts",
      "server/sandboxes/release-notes.ts",
      "server/api/release-notes.post.ts",
    ]);
    const vercelNitroConfig = vercelFiles.find(file => file.path === "nitro.config.ts")?.code;
    expect(vercelNitroConfig).toContain("provider: 'vercel'");
    expect(vercelNitroConfig).not.toContain("appType");
    expect(vercelNitroConfig).not.toContain("rollupOptions");
    expect(vercelFiles.find(file => file.path === "env.example")?.code).toContain("VERCEL_TOKEN=<vercel-token>");
  });

  it("includes a providers overview page in the docs manifest", () => {
    const providers = docsManifest.sections.find(section => section.id === "providers");

    expect(providers?.pages.some(page => page.id === "index")).toBe(true);
  });

  it("links provider overview pages to generated provider docs", () => {
    expect(getDocsPage("kv", "providers/cloudflare")).toBeTruthy();
    expect(getDocsPage("kv", "providers/vercel")).toBeTruthy();
    expect(getDocsPage("blob", "providers/cloudflare")).toBeTruthy();
    expect(getDocsPage("blob", "providers/vercel")).toBeTruthy();
    expect(getDocsPage("queue", "providers/cloudflare")).toBeTruthy();
    expect(getDocsPage("queue", "providers/vercel")).toBeTruthy();
    expect(getDocsPage("sandbox", "providers/cloudflare")?.group).toBe("Providers");
    expect(getDocsPage("sandbox", "providers/vercel")?.group).toBe("Providers");

    const gettingStarted = readFileSync(resolve(import.meta.dirname, "../content/docs/getting-started/index.md"), "utf8");
    const cloudflare = readFileSync(resolve(import.meta.dirname, "../content/docs/providers/cloudflare.md"), "utf8");
    const vercel = readFileSync(resolve(import.meta.dirname, "../content/docs/providers/vercel.md"), "utf8");

    expect(gettingStarted).toContain("to: /docs/vite/queue");
    expect(gettingStarted).toContain("to: /docs/vite/queue/quickstart");
    expect(gettingStarted).toContain("to: /docs/nitro/queue");
    expect(gettingStarted).toContain("to: /docs/nitro/queue/quickstart");
    expect(gettingStarted).toContain("to: /docs/vite/blob");
    expect(gettingStarted).toContain("to: /docs/vite/blob/quickstart");
    expect(gettingStarted).toContain("to: /docs/nitro/blob");
    expect(gettingStarted).toContain("to: /docs/nitro/blob/quickstart");
    expect(gettingStarted).not.toContain("/docs/nuxt/queue");
    expect(gettingStarted).not.toContain("/docs/nuxt/blob");
    expect(cloudflare).toContain("../kv/providers/cloudflare");
    expect(cloudflare).not.toContain("../kv/cloudflare");
    expect(cloudflare).toContain("/docs/vite/blob/providers/cloudflare");
    expect(cloudflare).toContain("/docs/nitro/blob/providers/cloudflare");
    expect(cloudflare).not.toContain("../blob/cloudflare");
    expect(cloudflare).toContain("/docs/vite/queue/providers/cloudflare");
    expect(cloudflare).toContain("/docs/nitro/queue/providers/cloudflare");
    expect(cloudflare).not.toContain("/docs/nuxt/queue/providers/cloudflare");
    expect(cloudflare).not.toContain("/docs/nuxt/blob/providers/cloudflare");
    expect(vercel).toContain("../kv/providers/vercel");
    expect(vercel).not.toContain("../kv/vercel");
    expect(vercel).toContain("/docs/vite/blob/providers/vercel");
    expect(vercel).toContain("/docs/nitro/blob/providers/vercel");
    expect(vercel).not.toContain("../blob/vercel");
    expect(vercel).toContain("/docs/vite/queue/providers/vercel");
    expect(vercel).toContain("/docs/nitro/queue/providers/vercel");
    expect(vercel).not.toContain("/docs/nuxt/queue/providers/vercel");
    expect(vercel).not.toContain("/docs/nuxt/blob/providers/vercel");
  });
});
