import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "yaml";

export function uiSdkVersions(lockfile) {
  const versions = new Map();
  for (const [, name, version] of lockfile.matchAll(/^ {2}'(@ui-sdk\/[^@']+)@([^(':]+)':$/gm)) {
    versions.set(name, [...(versions.get(name) ?? []), version]);
  }
  return versions;
}

export function versionFailures(versions) {
  if (versions.size === 0) return ["pnpm-lock.yaml has no @ui-sdk package."];
  const failures = [];
  for (const [name, list] of versions) {
    if (list.length > 1) failures.push(`${name} resolves to ${list.join(", ")}. Pin one version.`);
  }
  const all = new Set([...versions.values()].flat());
  if (failures.length === 0 && all.size > 1) {
    failures.push(
      `The @ui-sdk packages resolve to different versions: ${[...versions].map(([name, [version]]) => `${name}@${version}`).join(", ")}. Pin the same version for all of them.`,
    );
  }
  return failures;
}

export function uiSdkPatches(workspaceYaml) {
  return Object.keys(parse(workspaceYaml)?.patchedDependencies ?? {}).filter((key) =>
    key.startsWith("@ui-sdk/"),
  );
}

export function droppedPatches(basePatches, headPatches) {
  const headNames = new Set(headPatches.map((key) => key.slice(0, key.lastIndexOf("@"))));
  return basePatches.filter((key) => !headNames.has(key.slice(0, key.lastIndexOf("@"))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const baseRef = process.argv[2];
  const failures = versionFailures(
    uiSdkVersions(readFileSync(resolve(repoRoot, "pnpm-lock.yaml"), "utf8")),
  );
  for (const failure of failures) console.error(failure);
  if (failures.length > 0) process.exitCode = 1;
  else console.log("The @ui-sdk packages resolve to one version.");

  if (baseRef) {
    const base = execFileSync("git", ["show", `${baseRef}:pnpm-workspace.yaml`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const head = readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8");
    for (const key of droppedPatches(uiSdkPatches(base), uiSdkPatches(head))) {
      console.log(
        `::warning file=pnpm-workspace.yaml::This change drops the patch of ${key}. Check that the new version ships each of its fixes (the pull request that added the patch lists them).`,
      );
    }
  }
}
