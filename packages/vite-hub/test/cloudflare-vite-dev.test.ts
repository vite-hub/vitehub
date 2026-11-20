import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer, type PluginOption } from "vite"
import { expect, it, vi } from "vitest"

import { cloudflareNodeDevPlugin } from "../src/cloudflare-node-dev.ts"
import { vitehub } from "../src/index.ts"

import type { NitroConfig } from "nitro/types"

it.each([
  ["the default runner", undefined],
  ["a late Node runner override", {
    preset: "cloudflare-module",
    hooks: {
      "build:before": (nitro) => {
        nitro.options.devServer.runner = "node-worker"
      },
    },
  }],
] satisfies [string, NitroConfig | undefined][])("reads a Cloudflare Workspace in `vite dev` with %s", async (_name, config) => {
  const { nitro } = await import(createRequire(import.meta.url).resolve("nitro/vite")) as { nitro: (config?: NitroConfig) => PluginOption }
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
      plugins: [vitehub({ host: "cloudflare", env: false, workspace: true }), nitro(config)],
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

it("uses the effective runner for both Cloudflare modules and only applies in dev", () => {
  // SAFETY: these hooks are plain functions and read only `devServer.runner` from Nitro.
  const plugin = cloudflareNodeDevPlugin() as unknown as {
    apply: string
    nitro: { setup: (nitro: { options: { devServer: { runner: string } } }) => void }
    resolveId: (id: string) => string | undefined
  }
  expect(plugin.apply).toBe("serve")
  const nitro = { options: { devServer: { runner: "miniflare" } } }
  plugin.nitro.setup(nitro)
  expect(plugin.resolveId("cloudflare:workers")).toBeUndefined()
  expect(plugin.resolveId("cloudflare:email")).toBeUndefined()
  nitro.options.devServer.runner = "node-worker"
  expect(plugin.resolveId("cloudflare:workers")).toBe("\0vitehub-dev:cloudflare-workers")
  expect(plugin.resolveId("cloudflare:email")).toBe("\0vitehub-dev:cloudflare-email")
})
