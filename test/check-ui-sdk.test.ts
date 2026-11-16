import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  droppedPatches,
  uiSdkPatches,
  uiSdkVersions,
  versionFailures,
} from "../.github/scripts/check-ui-sdk.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

function lockfile(...entries: string[]) {
  return `packages:\n\n${entries.map((entry) => `  '${entry}':\n    resolution: {integrity: sha512-x}\n`).join("\n")}\nsnapshots:\n\n  '@ui-sdk/core@0.1.0-beta.2(patch_hash=abc)': {}\n`;
}

describe("check-ui-sdk", () => {
  it("accepts the repository's lockfile", () => {
    expect(
      versionFailures(uiSdkVersions(readFileSync(resolve(repoRoot, "pnpm-lock.yaml"), "utf8"))),
    ).toEqual([]);
  });

  it("reads package entries, not snapshots with a patch hash", () => {
    expect(
      uiSdkVersions(lockfile("@ui-sdk/core@0.1.0-beta.2", "@ui-sdk/vue@0.1.0-beta.2")),
    ).toEqual(
      new Map([
        ["@ui-sdk/core", ["0.1.0-beta.2"]],
        ["@ui-sdk/vue", ["0.1.0-beta.2"]],
      ]),
    );
  });

  it("fails on two versions of one package", () => {
    const versions = uiSdkVersions(
      lockfile(
        "@ui-sdk/core@0.1.0-beta.2",
        "@ui-sdk/core@0.1.0-beta.3",
        "@ui-sdk/vue@0.1.0-beta.3",
      ),
    );
    expect(versionFailures(versions)).toEqual([
      "@ui-sdk/core resolves to 0.1.0-beta.2, 0.1.0-beta.3. Pin one version.",
    ]);
  });

  it("fails when core and vue resolve to different versions", () => {
    const versions = uiSdkVersions(
      lockfile("@ui-sdk/core@0.1.0-beta.3", "@ui-sdk/vue@0.1.0-beta.2"),
    );
    expect(versionFailures(versions)).toEqual([
      "The @ui-sdk packages resolve to different versions: @ui-sdk/core@0.1.0-beta.3, @ui-sdk/vue@0.1.0-beta.2. Pin the same version for all of them.",
    ]);
  });

  it("fails when the lockfile has no ui-sdk", () => {
    expect(versionFailures(uiSdkVersions(lockfile("vue@3.5.44")))).toEqual([
      "pnpm-lock.yaml has no @ui-sdk package.",
    ]);
  });

  it("names a dropped patch, not one moved to the new version", () => {
    const base = uiSdkPatches(
      `patchedDependencies:\n  "@ui-sdk/core@0.1.0-beta.2": a.patch\n  "@ui-sdk/vue@0.1.0-beta.2": b.patch\n  vue@3.5.44: c.patch\n`,
    );
    expect(base).toEqual(["@ui-sdk/core@0.1.0-beta.2", "@ui-sdk/vue@0.1.0-beta.2"]);
    expect(droppedPatches(base, ["@ui-sdk/core@0.1.0-beta.3"])).toEqual([
      "@ui-sdk/vue@0.1.0-beta.2",
    ]);
  });
});
