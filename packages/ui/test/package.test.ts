import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js";

interface PackageManifest {
  dependencies: Record<string, string>;
  exports: Record<string, unknown>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
}

function parsePackageManifest(source: string): PackageManifest {
  const value: unknown = JSON.parse(source);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid @vite-hub/ui package manifest.");
  }
  const dependencies = stringRecord("dependencies" in value ? value.dependencies : undefined);
  const exports = unknownRecord("exports" in value ? value.exports : undefined);
  const peerDependencies = stringRecord("peerDependencies" in value ? value.peerDependencies : undefined);
  const peerDependenciesMeta = optionalPeerRecord(
    "peerDependenciesMeta" in value ? value.peerDependenciesMeta : undefined,
  );
  if (!dependencies || !exports || !peerDependencies || !peerDependenciesMeta) {
    throw new TypeError("Invalid @vite-hub/ui package manifest maps.");
  }
  return { dependencies, exports, peerDependencies, peerDependenciesMeta };
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  return { ...value };
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = unknownRecord(value);
  if (!record || Object.values(record).some(entry => typeof entry !== "string")) return;
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, String(entry)]));
}

function optionalPeerRecord(
  value: unknown,
): Record<string, { optional?: boolean }> | undefined {
  const record = unknownRecord(value);
  if (!record) return;
  const entries: Array<[string, { optional?: boolean }]> = [];
  for (const [key, entry] of Object.entries(record)) {
    const metadata = unknownRecord(entry);
    if (!metadata || (metadata.optional !== undefined && typeof metadata.optional !== "boolean")) {
      return;
    }
    entries.push([key, metadata.optional === undefined ? {} : { optional: metadata.optional }]);
  }
  return Object.fromEntries(entries);
}

const packageJson = parsePackageManifest(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

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
      vite: expect.any(String),
      vue: expect.any(String),
    });
    expect(packageJson.peerDependenciesMeta).toEqual({
      "@nuxt/ui": { optional: true },
      vite: { optional: true },
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

  it("leaves Pierre code row geometry under Pierre's control", () => {
    expect(styles).not.toContain("--diffs-line-height");
  });
});
