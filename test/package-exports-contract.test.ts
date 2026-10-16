import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const runtimeConditions = new Set(["browser", "default", "import", "node", "require", "worker", "workerd"]);

function isDistModuleTarget(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("./dist/") && value.endsWith(".js");
}

function readPublicPackages() {
  return readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(repoRoot, "packages", entry.name, "package.json");
      const manifest = JSON.parse(readFileSync(path, "utf8")) as {
        name?: string;
        private?: boolean;
        files?: string[];
        exports?: Record<string, unknown>;
      };
      return { manifest, path };
    })
    .filter(({ manifest }) => !manifest.private);
}

describe("published package contracts", () => {
  it("uses conditional exports for every JavaScript subpath", () => {
    const violations: string[] = [];

    for (const { manifest, path } of readPublicPackages()) {
      const packageName = manifest.name || path;
      for (const [subpath, target] of Object.entries(manifest.exports || {})) {
        if (isDistModuleTarget(target)) {
          violations.push(`${packageName} ${subpath} points directly to ${target}`);
          continue;
        }

        if (!target || typeof target !== "object" || Array.isArray(target)) continue;
        const conditions = target as Record<string, unknown>;
        const runtimeKeys = Object.keys(conditions).filter((key) => runtimeConditions.has(key));
        const hasRuntimeTarget = runtimeKeys.some((key) => isDistModuleTarget(conditions[key]));
        if (hasRuntimeTarget && !Object.hasOwn(conditions, "types")) {
          violations.push(
            `${packageName} ${subpath} has a runtime target without a types condition`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("allowlists the built package and manifest", () => {
    const violations = readPublicPackages()
      .filter(
        ({ manifest }) =>
          !manifest.files?.includes("dist") || !manifest.files.includes("package.json"),
      )
      .map(({ manifest, path }) => manifest.name || path);

    expect(violations).toEqual([]);
  });
});
