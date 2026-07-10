import { describe, expect, it } from "vitest";
import { docsManifest } from "../modules/vitehub-docs/runtime/utils/docs";
import { getShowcaseExamples, getShowcaseFiles, getShowcasePhasePaths } from "../modules/vitehub-docs/runtime/utils/showcase";
import { generateFrameworkConfig } from "../modules/vitehub-docs/shared/showcase";

describe("showcase examples", () => {
  it("loads generated examples for the landing page", () => {
    const examples = getShowcaseExamples();
    const kv = examples.find(example => example.docsPath === "kv");

    expect(kv?.label).toBe("KV");
    expect(docsManifest.examples.length).toBeGreaterThan(0);
  });

  it("returns phase files for the default landing example framework", () => {
    const kv = getShowcaseExamples().find(example => example.docsPath === "kv");
    expect(kv).toBeTruthy();

    const phases = getShowcasePhasePaths(kv!, "vite", "build");
    expect(phases.configure).toBe("vite.config.ts");
    expect(phases.run).toBe("src/server.ts");
  });

  it("keeps phase files first for the selected landing showcase", () => {
    const kv = getShowcaseExamples().find(example => example.docsPath === "kv");
    expect(kv).toBeTruthy();

    const files = getShowcaseFiles(kv!, "vite", "build");
    expect(files.slice(0, 3).map(file => file.path)).toEqual(["vite.config.ts", "src/server.ts", "package.json"]);
  });

  it("renders landing config examples through the ViteHub preset", () => {
    for (const example of getShowcaseExamples()) {
      const providerId = example.providers[0]?.id;
      const files = getShowcaseFiles(example, "vite", providerId || "build");
      const config = files.find(file => file.path === "vite.config.ts");

      expect(config?.code).toContain("import { vitehub } from '@vite-hub/vite'");
      expect(config?.code).toContain("plugins: [vitehub()]");
      expect(config?.code).not.toMatch(/\bhub[A-Z]\w+\(/);
    }

    expect(generateFrameworkConfig("env({})")).toContain("import { env } from '@vite-hub/env/vite'");
  });

  it("applies provider overrides without changing showcase ordering", () => {
    const kv = getShowcaseExamples().find(example => example.docsPath === "kv");
    expect(kv).toBeTruthy();

    const files = getShowcaseFiles(kv!, "vite", "upstash");
    const config = files.find(file => file.path === "vite.config.ts")?.code;

    expect(files.slice(0, 2).map(file => file.path)).toEqual(["vite.config.ts", "src/server.ts"]);
    expect(config).toContain("appType: 'custom'");
    expect(config).toContain("input: resolve(import.meta.dirname, 'src/server.ts')");
    expect(config).toContain("driver: 'upstash'");
    expect(config).toContain("plugins: [vitehub()]");
    expect(files.find(file => file.path === "env.example")?.code).toContain("KV_REST_API_URL=https://example.upstash.io");
  });

  it("shows provider tabs for supported non-default runtimes", () => {
    const providersByExample = Object.fromEntries(
      getShowcaseExamples().map(example => [example.docsPath, example.providers.map(provider => provider.id)]),
    );

    expect(providersByExample.blob).toEqual(expect.arrayContaining(["netlify-blobs", "minio"]));
    expect(providersByExample.kv).toEqual(expect.arrayContaining(["deno-kv", "fs-lite"]));
    expect(providersByExample.schedule).toEqual(expect.arrayContaining(["netlify", "deno"]));
    expect(providersByExample.workflow).toEqual(expect.arrayContaining(["openworkflow"]));
    expect(providersByExample.queue).toEqual(["cloudflare", "vercel"]);
    expect(providersByExample.sandbox).toEqual(["cloudflare", "vercel"]);
  });
});
