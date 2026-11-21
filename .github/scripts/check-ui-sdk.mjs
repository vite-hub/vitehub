// ViteHub pins @ui-sdk/core and @ui-sdk/vue and patches them (patchedDependencies in pnpm-workspace.yaml). pnpm
// already fails the install when a patch names a version that is not installed. This script checks what pnpm does not:
//
// 1. Every @ui-sdk package in the lockfile resolves to one version, the same for all of them. @ui-sdk/vue calls into
//    @ui-sdk/core, and the kit build inlines core's web.css, so two versions ship parts and styles that do not match.
// 2. Given a base ref, it warns when the change drops a ui-sdk patch. A patch holds fixes that npm does not have yet,
//    so check that the new ui-sdk version ships each of them.
//
// Run: node .github/scripts/check-ui-sdk.mjs [<base ref>]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "yaml";

/** The `@ui-sdk/*` package versions of a pnpm lockfile, as a map from package name to its versions. */
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

/** The `@ui-sdk/*` keys of patchedDependencies in a pnpm-workspace.yaml. */
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
