import { describe, expect, it } from "vitest"
import { resolve } from "node:path"

import { listWorkspacePackageInfos, listWorkspacePackageNames } from "../src/workspace-inventory.ts"

const repoRoot = resolve(import.meta.dirname, "../../..")

describe("workspace inventory", () => {
  it("lists publishable ViteHub packages from the workspace", () => {
    expect(listWorkspacePackageNames(repoRoot)).toEqual([
      "agent",
      "blob",
      "ci",
      "cli",
      "database",
      "devtools",
      "env",
      "kv",
      "queue",
      "runtime",
      "sandbox",
      "schedule",
      "shell",
      "source",
      "workflow",
      "workspace",
    ])
  })

  it("maps the cli workspace to the unscoped npm package", () => {
    expect(listWorkspacePackageInfos(repoRoot).find(entry => entry.name === "cli")).toEqual(
      expect.objectContaining({
        name: "cli",
        packageName: "vite-hub",
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
