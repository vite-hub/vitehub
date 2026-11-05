import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };
import { normalizePackageExports } from "../src/package-exports.ts";

function distributionTargets(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("./dist/") ? [value] : [];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(distributionTargets);
}

describe("internal package exports", () => {
  it("points every distribution export at a generated file", () => {
    const missing = [...new Set(distributionTargets(manifest.exports))]
      .filter(target => !existsSync(new URL(target, new URL("../", import.meta.url))));

    expect(missing).toEqual([]);
  });
});

describe("normalizePackageExports", () => {
  it("adds ESM conditions to distribution imports", () => {
    expect(normalizePackageExports({
      "./feature": "./dist/feature.js",
      "./metadata": "./package.json",
    })).toEqual({
      "./feature": {
        types: "./dist/feature.d.ts",
        import: "./dist/feature.js",
        default: "./dist/feature.js",
      },
      "./metadata": "./package.json",
    });
  });

  it("preserves explicit conditions", () => {
    expect(normalizePackageExports({
      "./feature": {
        types: "./dist/feature.d.ts",
        import: "./dist/feature.js",
        default: "./dist/feature.mjs",
      },
    })["./feature"]).toEqual({
      types: "./dist/feature.d.ts",
      import: "./dist/feature.js",
      default: "./dist/feature.mjs",
    });
  });
});
