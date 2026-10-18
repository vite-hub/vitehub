import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js";
import { componentNames } from "../src/component-names.ts";

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
  const peerDependencies = stringRecord(
    "peerDependencies" in value ? value.peerDependencies : undefined,
  );
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
  if (!record || Object.values(record).some((entry) => typeof entry !== "string")) return;
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, String(entry)]));
}

function optionalPeerRecord(value: unknown): Record<string, { optional?: boolean }> | undefined {
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
const stylesheet = readFileSync(new URL("../dist/styles.css", import.meta.url), "utf8");

describe("@vite-hub/ui package contract", () => {
  it("exposes the documented entrypoints", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual(
      [".", "./code-block", "./headless", "./nuxt", "./package.json", "./primitive-rail", "./styles.css", "./vite"].sort(),
    );
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
      "@comark/vue": "0.7.0",
      katex: "^0.17.0",
      "@iconify-json/ph": "catalog:ui",
      "@nuxt/kit": "4.6.2",
      "@shikijs/langs": "4.5.0",
      "@types/node": "catalog:tooling",
      "nostics": "catalog:runtime",
      "reka-ui": "catalog:ui",
      shiki: "^4.5.0",
    });
  });

  // Each fresh Node process gets its own timeout and reports the failing entrypoint.
  it.each([
    ".",
    "./code-block",
    "./headless",
    "./nuxt",
    "./primitive-rail",
    "./vite",
  ])("loads JavaScript entrypoint %s from the built package", async (entry) => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/ui", [entry]);
  });

  it("exports every component from the root entry", async () => {
    const root: Record<string, unknown> = await import("../dist/index.js");
    for (const component of componentNames) expect(root[component], component).toBeDefined();
  });

  it("ships flat console surfaces that fill their containers", () => {
    for (const block of [".vh-chat", ".vh-session"]) {
      expect(stylesheet, block).toMatch(new RegExp(`\\n${block.replace(".", "\\.")}\\s*\\{[^}]*height: 100%;[^}]*min-height: 0;`));
    }
    expect(stylesheet).not.toMatch(/backdrop-filter|mask-image|linear-gradient/);
    expect(stylesheet).not.toContain("--vh-ui-text-muted");
  });

  it("keeps the Pierre renderer behind an on-demand chunk", () => {
    const dist = new URL("../dist/", import.meta.url);
    const sources = ["index.js", ...readdirSync(dist).filter((name) => /^agent-code-view-[^/]+\.js$/.test(name))]
      .map((name) => readFileSync(new URL(name, dist), "utf8"));
    const rendererImport = sources
      .map((source) => source.match(/import\("\.\/(pierre-code-view-[^"]+\.js)"\)/)?.[1])
      .find((name): name is string => name !== undefined);

    expect(rendererImport).toBeDefined();
    expect(existsSync(new URL(rendererImport!, dist))).toBe(true);
  });
});
