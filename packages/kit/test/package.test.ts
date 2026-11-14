import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js";
import { kitEntries, ownEntries, uiSdkEntries } from "./entries.ts";

const manifest: {
  dependencies: Record<string, string>;
  exports: Record<string, unknown>;
  peerDependencies: Record<string, string>;
} = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("@vite-hub/kit package contract", () => {
  it("installs ui-sdk and nothing else", () => {
    // The package exists so that headless parts do not install the dependencies of @vite-hub/ui (CodeMirror, xterm, Shiki).
    expect(manifest.dependencies).toEqual({ "@ui-sdk/core": "0.1.0-beta.2", "@ui-sdk/vue": "0.1.0-beta.2" });
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual(["@nuxt/kit", "@nuxt/schema", "nuxt", "vue"]);
  });

  it("has 5 entries or fewer", () => {
    expect(Object.keys(manifest.exports).length).toBeLessThanOrEqual(5);
  });

  it("has one entry for each part it adds, and none that ui-sdk has", () => {
    expect(kitEntries.toSorted()).toEqual(ownEntries.toSorted());
    expect(kitEntries.filter((entry) => uiSdkEntries.includes(entry))).toEqual([]);
  });

  it("loads each entry from the built package", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/kit", [...kitEntries, "nuxt"]);
  }, 60_000);
});
