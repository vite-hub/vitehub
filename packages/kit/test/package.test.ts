import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js";
import { kitEntries, kitOwnEntries, uiSdkEntries } from "./entries.ts";

const manifest: {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
} = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("@vite-hub/kit package contract", () => {
  it("installs ui-sdk and nothing else", () => {
    // The package exists so that headless parts do not install the dependencies of @vite-hub/ui (CodeMirror, xterm, Shiki).
    expect(manifest.dependencies).toEqual({ "@ui-sdk/core": "0.1.0-beta.2", "@ui-sdk/vue": "0.1.0-beta.2" });
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual(["@json-render/core", "@json-render/vue", "@nuxt/kit", "@nuxt/schema", "nuxt", "vue", "zod"]);
  });

  it("keeps the catalog peers optional and on the Console's json-render pin", () => {
    // Only `@vite-hub/kit/catalog` and `@vite-hub/kit/catalog/vue` import them, so an app that uses only parts installs none.
    for (const peer of ["@json-render/core", "@json-render/vue", "zod"]) expect(manifest.peerDependenciesMeta[peer]).toEqual({ optional: true });
    const viteHub: { peerDependencies: Record<string, string> } = JSON.parse(readFileSync(new URL("../../vite-hub/package.json", import.meta.url), "utf8"));
    expect(manifest.peerDependencies["@json-render/core"]).toBe(viteHub.peerDependencies["@json-render/core"]);
    expect(manifest.peerDependencies["@json-render/vue"]).toBe(viteHub.peerDependencies["@json-render/vue"]);
  });

  it("has one entry for each entry of @ui-sdk/vue", () => {
    expect(kitEntries.toSorted()).toEqual(uiSdkEntries.toSorted());
  });

  it("loads each entry from the built package", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/kit", [...kitEntries, ...kitOwnEntries]);
  }, 60_000);
});
