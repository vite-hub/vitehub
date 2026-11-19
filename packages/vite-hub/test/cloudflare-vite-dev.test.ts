import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer, type PluginOption } from "vite"
import { expect, it, vi } from "vitest"

import { cloudflareNodeDevPlugin } from "../src/cloudflare-node-dev.ts"
import { vitehub } from "../src/index.ts"

it("starts `vite dev` on the Node runner for a Cloudflare app with a Workspace", async () => {
  const { nitro } = await import(createRequire(import.meta.url).resolve("nitro/vite")) as { nitro: () => PluginOption }
  const root = await mkdtemp(join(tmpdir(), "vitehub-cloudflare-vite-dev-"))
  const packages = fileURLToPath(new URL("../..", import.meta.url))
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  // Under Vitest, ViteHub stubs `cloudflare:workers` for every app. Run the dev server as `vite dev` runs it.
  vi.stubEnv("VITEST", undefined)
  try {
    await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
    for (const name of ["workspace", "source"]) await symlink(join(packages, name), join(root, "node_modules/@vite-hub", name), "dir")
    await symlink(join(packages, "vite-hub/node_modules/h3"), join(root, "node_modules/h3"), "dir")
    await symlink(join(packages, "vite-hub"), join(root, "node_modules/vite-hub"), "dir")
    await mkdir(join(root, "server/workspaces"), { recursive: true })
    await mkdir(join(root, "notes"), { recursive: true })
    await mkdir(join(root, "server/routes"), { recursive: true })
    await writeFile(join(root, "server/workspaces/notes.ts"), "import { defineWorkspace, glob } from 'vite-hub/workspace'\nexport default defineWorkspace({ sources: { notes: glob({ cwd: 'notes', include: '**/*.md' }) } })\n")
    await writeFile(join(root, "notes/hello.md"), "Hello\n")
    await writeFile(join(root, "server/routes/notes.ts"), [
      "import { defineHandler } from 'nitro'",
      "import { useWorkspace } from 'vite-hub/workspace'",
      "export default defineHandler(async () => useWorkspace('notes').fs.glob('**/*.md'))",
      "",
    ].join("\n"))
    server = await createServer({
      root,
      configFile: false,
      appType: "custom",
      logLevel: "silent",
      plugins: [vitehub({ host: "cloudflare", env: false, workspace: true }), nitro()],
      server: { port: 0, watch: null, fs: { allow: [root, join(packages, "..")] } },
    })
    await server.listen()
    const response = await fetch(new URL("/notes", server.resolvedUrls!.local[0]!))
    expect(response.status, (await response.clone().text()).slice(0, 300)).toBe(200)
    expect(await response.json()).toMatchObject([{ path: "notes/hello.md" }])
  }
  finally {
    await server?.close()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

it("keeps the real `cloudflare:workers` for the miniflare runner and for builds", async () => {
  const resolve = async (command: "build" | "serve", runner?: string) => {
    // SAFETY: the plugin defines these hooks as plain functions, and reads only `command` and `devServer.runner`.
    const plugin = cloudflareNodeDevPlugin("cloudflare") as unknown as {
      configResolved: (config: { command: string }) => void
      nitro: { setup: (nitro: { options: { devServer: { runner?: string } } }) => void }
      resolveId: (id: string) => string | undefined
    }
    plugin.configResolved({ command })
    plugin.nitro.setup({ options: { devServer: { runner } } })
    return plugin.resolveId("cloudflare:workers")
  }
  expect(await resolve("serve")).toBe("\0vitehub-dev:cloudflare-workers")
  expect(await resolve("serve", "node-worker")).toBe("\0vitehub-dev:cloudflare-workers")
  expect(await resolve("serve", "miniflare")).toBeUndefined()
  expect(await resolve("build")).toBeUndefined()
})
