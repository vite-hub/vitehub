import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { expect, it } from "vitest"

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url))

it("loads @vercel/blob with the first Vercel Blob Workspace call, not with the hosted runtime", () => {
  const script = `
    import { readFileSync } from "node:fs"
    import { registerHooks } from "node:module"
    import { fileURLToPath } from "node:url"

    const requests = []
    globalThis.fetch = async (input) => {
      requests.push(String(input))
      return new Response(null, { status: 404 })
    }
    const loaded = new Set()
    registerHooks({
      load(url, context, nextLoad) {
        if (url.startsWith("file:")) loaded.add(fileURLToPath(url))
        return nextLoad(url, context)
      },
    })
    const vercelBlobLoaded = () => [...loaded].some(file => readFileSync(file, "utf8").includes("BlobServiceNotAvailable"))

    const { installHostedVercelBlobWorkspaceRuntime } = await import("@vite-hub/workspace/internal/runtime/hosted-vercel-blob")
    const { getWorkspaceHostedStoreLoader } = await import("@vite-hub/workspace/runtime")
    installHostedVercelBlobWorkspaceRuntime()
    const store = getWorkspaceHostedStoreLoader()({ provider: "vercel-blob" }, "docs")
    const atInstall = vercelBlobLoaded()
    const file = await store.readFile("README.md")
    console.log(JSON.stringify({ atInstall, afterRead: vercelBlobLoaded(), file: file ?? null, requests: requests.length > 0 }))
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: { ...process.env, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_store_secret" },
  })

  expect(result.status, result.stderr).toBe(0)
  // The stubbed fetch answers 404, so the read reaches @vercel/blob and finds no file.
  expect(JSON.parse(result.stdout)).toEqual({ atInstall: false, afterRead: true, file: null, requests: true })
})
