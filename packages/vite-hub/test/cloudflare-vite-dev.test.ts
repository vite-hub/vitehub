import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer, resolveConfig, type PluginOption } from "vite"
import { expect, it, vi } from "vitest"
import { hubAgent } from "@vite-hub/agent/vite"

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

it.each(["late override", "standalone Agent"] as const)("inlines packages for Miniflare selected by %s", async (scenario) => {
  const { nitro } = await import(createRequire(import.meta.url).resolve("nitro/vite")) as { nitro: (config?: NitroConfig) => PluginOption }
  const root = await mkdtemp(join(tmpdir(), "vitehub-dev-loading-"))
  const nodeRoot = join(root, "node-app")
  const dist = join(root, "node_modules/@vite-hub/agent/dist")
  const file = join(dist, "probe.js")
  const late = scenario === "late override"
  try {
    for (const app of [root, nodeRoot]) {
      const routes = join(app, "server/routes")
      await mkdir(routes, { recursive: true })
      await writeFile(join(routes, "index.ts"), 'export default { fetch: () => new Response("ok") }\n')
    }
    const config = await resolveConfig({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        late ? vitehub({ host: "node", agent: true, env: false }) : hubAgent(),
        nitro({
          devServer: { runner: late ? "node-worker" : "miniflare" },
          hooks: late ? { "build:before": (nitro) => { nitro.options.devServer.runner = "miniflare" } } : {},
        }),
      ],
    }, "serve")
    const noExternal = config.environments.nitro!.resolve.noExternal
    expect(noExternal === true || Array.isArray(noExternal) && noExternal.some(pattern =>
      typeof pattern === "string" ? pattern === "@vite-hub/agent" : pattern.test("@vite-hub/agent"),
    )).toBe(true)

    const node = await resolveConfig({
      root: nodeRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [vitehub({ host: "node", agent: true, env: false }), nitro({ devServer: { runner: "node-worker" } })],
    }, "serve")
    await mkdir(dist, { recursive: true })
    await writeFile(file, "export const probe = true\n")
    function loadGeneratedImport(plugins: typeof config.plugins) {
      const agent = plugins.find(plugin => plugin.name === "@vite-hub/agent/vite")!
      const load = typeof agent.load === "function" ? agent.load : agent.load!.handler
      return Reflect.apply(load, { environment: { name: "nitro" } }, [file])
    }
    expect(await loadGeneratedImport(node.plugins)).toContain("data:text/javascript")
    expect(await loadGeneratedImport(config.plugins)).toBeUndefined()
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
