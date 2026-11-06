import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"
import * as workspace from "../src/index.ts"
import { useWorkspaceFiles as open } from "../src/files.ts"
import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"
import { registerWorkspace, resetWorkspaceRegistry } from "../src/core/registry.ts"
import { resetWorkspaceAssetsRegistry } from "../src/asset-registry.ts"

afterEach(() => {
  resetWorkspaceRegistry()
  resetWorkspaceAssetsRegistry()
})

describe("Workspace file runtime", () => {
  it("reads, writes, and snapshots files without constructing Agent tools", async () => {
    registerWorkspace("files", workspace.defineWorkspace({ store: { provider: "memory" } }))
    const files = open("files", { mode: "write" })
    await files.fs.writeFile("guide.md", "# Guide")
    const snapshot = await files.history.checkpoint({ message: "Guide" })
    expect(snapshot.id).toBeTruthy()
    expect(await open("files").fs.readFile("guide.md")).toBe("# Guide")
    expect("tools" in files).toBe(false)
    expect("tools" in open("files")).toBe(false)
  })

  it("loads the public file-only entry", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/workspace", ["./files"])
  })

  it("keeps Agent tools out of the built file entry without tree shaking", async () => {
    const result = await build({
      stdin: {
        contents: 'export { useWorkspaceFiles } from "./dist/files.js"',
        resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      },
      bundle: true,
      treeShaking: false,
      format: "esm",
      platform: "node",
      packages: "external",
      write: false,
    })
    expect(result.outputFiles[0]!.text).not.toContain("@vite-hub/shell/workspace")
    expect(result.outputFiles[0]!.text).not.toContain("maxShellCalls")
  })
})
