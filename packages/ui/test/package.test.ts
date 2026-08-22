import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  dependencies: Record<string, string>;
  exports: Record<string, unknown>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

describe("@vite-hub/ui package contract", () => {
  it("exposes the documented entrypoints", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      ".",
      "./headless",
      "./nuxt",
      "./package.json",
      "./styles.css",
      "./vite",
    ]);
    expect(packageJson.peerDependencies).toMatchObject({
      "@nuxt/ui": expect.any(String),
      ai: expect.any(String),
      vue: expect.any(String),
    });
    expect(packageJson.peerDependenciesMeta).toEqual({
      "@nuxt/ui": { optional: true },
      ai: { optional: true },
      vue: { optional: true },
    });
    expect(packageJson.dependencies).toEqual({
      "@comark/vue": "0.6.2",
      "@nuxt/kit": "4.4.8",
    });
  });

  it("loads every JavaScript entrypoint from the built package", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/ui", [
      ".",
      "./headless",
      "./nuxt",
      "./vite",
    ]);
  });
});
