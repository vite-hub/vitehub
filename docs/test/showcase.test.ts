import { describe, expect, it } from "vitest";
import { docsManifest } from "../modules/vitehub-docs/runtime/utils/docs";
import { getShowcaseExamples, getShowcaseFiles, getShowcasePhasePaths } from "../modules/vitehub-docs/runtime/utils/showcase";

describe("showcase examples", () => {
  it("loads generated examples from the docs manifest", () => {
    const examples = getShowcaseExamples();
    const dummy = examples.find(example => example.docsPath === "dummy");

    expect(dummy?.label).toBe("Dummy");
    expect(docsManifest.examples.length).toBeGreaterThan(0);
  });

  it("returns the phase paths for the selected framework and mode", () => {
    const dummy = getShowcaseExamples().find(example => example.docsPath === "dummy");
    expect(dummy).toBeTruthy();

    const phases = getShowcasePhasePaths(dummy!, "vite", "build");
    expect(phases.run).toBe("src/build.ts");
  });

  it("keeps phase files first for the selected framework and mode", () => {
    const dummy = getShowcaseExamples().find(example => example.docsPath === "dummy");
    expect(dummy).toBeTruthy();

    const files = getShowcaseFiles(dummy!, "vite", "build");
    expect(files.slice(0, 2).map(file => file.path)).toEqual(["vite.config.ts", "src/build.ts"]);
  });
});
