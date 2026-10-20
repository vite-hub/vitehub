import { describe, expect, it } from "vitest";

import { normalizePackageExports } from "../src/package-exports.ts";

describe("normalizePackageExports", () => {
  it("adds portable conditions to distribution imports", () => {
    expect(normalizePackageExports({
      "./feature": "./dist/feature.js",
      "./metadata": "./package.json",
    })).toEqual({
      "./feature": {
        types: "./dist/feature.d.ts",
        import: "./dist/feature.js",
        require: "./dist/feature.js",
        default: "./dist/feature.js",
      },
      "./metadata": "./package.json",
    });
  });

  it("preserves explicit conditions while filling missing portable ones", () => {
    expect(normalizePackageExports({
      "./feature": {
        types: "./dist/feature.d.ts",
        import: "./dist/feature.js",
        require: "./dist/feature.cjs",
      },
    })["./feature"]).toEqual({
      types: "./dist/feature.d.ts",
      import: "./dist/feature.js",
      require: "./dist/feature.cjs",
      default: "./dist/feature.js",
    });
  });
});
