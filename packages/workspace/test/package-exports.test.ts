import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url))

describe("workspace package exports", () => {
  it("keeps generated registries private", () => {
    const script = `
      const registries = [
        "@vite-hub/workspace/internal/runtime/empty-assets-registry",
        "@vite-hub/workspace/internal/runtime/empty-registry",
      ]

      for (const specifier of registries) {
        let error
        try {
          await import(specifier)
        }
        catch (cause) {
          error = cause
        }
        if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
          throw error || new Error(\`Expected \${specifier} to be private\`)
        }
      }

      await import("#vitehub-workspace-assets-registry")
      await import("#vitehub-workspace-registry")
      await import("@vite-hub/workspace/cloudflare")
      await import("@vite-hub/workspace/internal/runtime/hosted-vercel-blob")
    `
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: workspaceRoot,
      encoding: "utf8",
    })

    expect(result.status, result.stderr).toBe(0)
  })
})
