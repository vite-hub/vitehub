import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { Miniflare } from "miniflare"
import { createBuilder } from "vite"
import { expect, it } from "vitest"

import { vitehub } from "vite-hub"

const route = `
import { defineEventHandler } from "h3"
import { analyzeShellCommand } from "vite-hub/shell"
import { createReadonlyWorkspaceFs, runWorkspaceInspectionCommand, workspaceMountPoint } from "vite-hub/shell/workspace"

const readme = "# Docs\\n"
const workspace = {
  exists: async (path: string) => path === "" || path === "README.md",
  list: async () => [{ path: "README.md", size: readme.length, type: "file" as const }],
  readFile: async () => readme,
  search: async () => [],
  stat: async (path: string) => path === "README.md" ? { path, size: readme.length, type: "file" as const } : { path, type: "directory" as const },
}

export default defineEventHandler(async () => {
  const options = { commands: ["cat"], cwd: workspaceMountPoint, fs: createReadonlyWorkspaceFs(workspace) }
  return {
    analysis: await analyzeShellCommand("cat README.md | rg x", { timeoutMs: 10_000 }),
    allowed: (await runWorkspaceInspectionCommand(workspace, "cat README.md", options)).stdout,
    denied: (await runWorkspaceInspectionCommand(workspace, "cat README.md && rm README.md", options)).event,
  }
})
`

it("parses shell commands with sh-syntax in a Cloudflare Worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-shell-cloudflare-"))
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await mkdir(join(root, "server/api"), { recursive: true })
    await writeFile(join(root, "server/api/shell.get.ts"), route)
    const builder = await createBuilder({ logLevel: "silent", plugins: [vitehub({ host: "cloudflare" })], root })
    await builder.buildApp()

    const server = join(root, ".output/server")
    const files = await readdir(server, { recursive: true })
    const worker = new Miniflare({
      compatibilityDate: "2026-04-20",
      compatibilityFlags: ["nodejs_compat"],
      // Wrangler uploads the emitted WASM file as a compiled module, so the Worker imports it without compiling bytes.
      modules: [
        ...["index.mjs", ...files.filter(file => file.endsWith(".mjs") && file !== "index.mjs")].map(file => ({ path: join(server, file), type: "ESModule" as const })),
        ...files.filter(file => file.endsWith(".wasm")).map(file => ({ path: join(server, file), type: "CompiledWasm" as const })),
      ],
      modulesRoot: server,
    })
    try {
      const response = await worker.dispatchFetch("http://localhost/api/shell")
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        allowed: "# Docs\n",
        analysis: { commands: ["cat", "rg"], hasPipelines: true, ok: true },
        denied: "policy_denied",
      })
    }
    finally {
      await worker.dispose()
    }
  }
  finally {
    await rm(root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 300_000)
