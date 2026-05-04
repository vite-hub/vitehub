import { describe, expect, it } from "vitest"
import { resolve } from "node:path"

import { listWorkspacePackageInfos, listWorkspacePackageNames } from "../src/workspace-inventory.ts"

const repoRoot = resolve(import.meta.dirname, "../../..")

describe("workspace inventory", () => {
  it("lists publishable @vitehub packages from the workspace", () => {
    expect(listWorkspacePackageNames(repoRoot)).toEqual([
      "blob",
      "chat",
      "db",
      "env",
      "kv",
      "queue",
      "sandbox",
      "unshell",
      "workflow",
      "workspace",
    ])
  })

  it("can include private workspace packages when requested", () => {
    expect(listWorkspacePackageInfos(repoRoot).find(entry => entry.name === "internal")).toEqual(
      expect.objectContaining({
        name: "internal",
        packageName: "@vitehub/internal",
        private: true,
      }),
    )
  })
})
