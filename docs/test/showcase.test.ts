import { describe, expect, it } from "vitest";
import { docsManifest } from "../modules/vitehub-docs/runtime/utils/docs";
import { getShowcaseExamples, getShowcaseFiles, getShowcasePhasePaths } from "../modules/vitehub-docs/runtime/utils/showcase";

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
    expect(phases.run).toBe("src/main.ts");
  });

  it("keeps phase files first for the selected landing showcase", () => {
    const kv = getShowcaseExamples().find(example => example.docsPath === "kv");
    expect(kv).toBeTruthy();

    const files = getShowcaseFiles(kv!, "vite", "build");
    expect(files.slice(0, 3).map(file => file.path)).toEqual(["vite.config.ts", "src/main.ts", "package.json"]);
  });

  it("applies provider overrides without changing showcase ordering", () => {
    const kv = getShowcaseExamples().find(example => example.docsPath === "kv");
    expect(kv).toBeTruthy();

    const files = getShowcaseFiles(kv!, "vite", "upstash");
    expect(files.slice(0, 2).map(file => file.path)).toEqual(["vite.config.ts", "src/main.ts"]);
    expect(files.find(file => file.path === "vite.config.ts")?.code).toContain("driver: 'upstash'");
    expect(files.find(file => file.path === "env.example")?.code).toContain("KV_REST_API_URL=https://example.upstash.io");
  });
});
