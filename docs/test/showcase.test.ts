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
    expect(packageFile!.code).toContain("\"nitro\": \"3.0.260415-beta\"");
  });

  it("includes a providers overview page in the docs manifest", () => {
    const providers = docsManifest.sections.find(section => section.id === "providers");

    expect(providers?.pages.some(page => page.id === "index")).toBe(true);
  });

  it("links provider overview pages to generated KV provider pages", () => {
    expect(getDocsPage("kv", "providers/cloudflare")).toBeTruthy();
    expect(getDocsPage("kv", "providers/vercel")).toBeTruthy();

    const cloudflare = readFileSync(resolve(import.meta.dirname, "../content/docs/providers/cloudflare.md"), "utf8");
    const vercel = readFileSync(resolve(import.meta.dirname, "../content/docs/providers/vercel.md"), "utf8");

    expect(cloudflare).toContain("../kv/providers/cloudflare");
    expect(cloudflare).not.toContain("../kv/cloudflare");
    expect(vercel).toContain("../kv/providers/vercel");
    expect(vercel).not.toContain("../kv/vercel");
  });
});
