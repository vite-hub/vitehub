import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { listWorkspacePackageInfos, listWorkspacePackageNames } from "../src/workspace-inventory.ts"

const repoRoot = resolve(import.meta.dirname, "../../..")

describe("workspace inventory", () => {
  it("lists publishable ViteHub packages from the workspace, and private ones on request", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-inventory-"))
    try {
      const writePackage = async (dir: string, manifest: Record<string, unknown>) => {
        await mkdir(join(root, "packages", dir), { recursive: true })
        await writeFile(join(root, "packages", dir, "package.json"), JSON.stringify(manifest))
      }
      await writePackage("zeta", { name: "@vite-hub/zeta" })
      await writePackage("framework", { name: "vite-hub" })
      await writePackage("internal", { name: "@vite-hub/internal", private: true })
      await writePackage("other", { name: "other-package" })
      await mkdir(join(root, "packages", "no-manifest"), { recursive: true })

      expect(listWorkspacePackageNames(root)).toEqual(["framework", "zeta"])
      expect(listWorkspacePackageNames(root, { includePrivate: true })).toEqual(["framework", "internal", "zeta"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("maps the framework workspace to the unscoped npm package", () => {
    expect(listWorkspacePackageInfos(repoRoot).find(entry => entry.name === "vite-hub")).toEqual(
      expect.objectContaining({
        name: "vite-hub",
        packageName: "vite-hub",
        private: false,
      }),
    )
  })

  it("maps the cli workspace to the scoped npm package", () => {
    expect(listWorkspacePackageInfos(repoRoot).find(entry => entry.name === "cli")).toEqual(
      expect.objectContaining({
        name: "cli",
        packageName: "@vite-hub/cli",
        private: false,
      }),
    )
  })

  it("can include private workspace packages when requested", () => {
    expect(listWorkspacePackageInfos(repoRoot).find(entry => entry.name === "internal")).toEqual(
      expect.objectContaining({
        name: "internal",
        packageName: "@vite-hub/internal",
        private: true,
      }),
    )
  })
})
