import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { getWorkspaceHostedStoreLoader, setWorkspaceHostedStoreLoader } from "../src/runtime/state.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Connect } from "vite"

const runWorkspaceDevCommand = vi.hoisted(() => vi.fn(async (_input?: { abortSignal?: AbortSignal, onProgress?: (event: { id: string, label: string, status: "started" | "completed" }) => void | Promise<void> }) => ({
  exitCode: 0,
  stderr: "",
  stdout: "ok\n",
})))

vi.mock("@vite-hub/internal/build/vercel-runtime-packages", () => ({
  copyVercelFunctionRuntimePackages: vi.fn(async () => undefined),
}))

vi.mock("../src/server.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server.ts")>()
  return {
    ...actual,
    runWorkspaceDevCommand,
  }
})

const tempDirs: string[] = []

function responseChunkText(chunk: unknown) {
  if (typeof chunk === "string") return chunk
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8")
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8")
  return String(chunk)
}

async function configurePluginServer(plugin: { configureServer?: unknown }, server: unknown) {
  const hook = plugin.configureServer
  if (typeof hook === "function") {
    await hook(server)
  }
  else if (hook && typeof hook === "object" && "handler" in hook && typeof hook.handler === "function") {
    await hook.handler(server)
  }
}

async function invokeMiddleware(
  handler: Connect.NextHandleFunction,
  body: Record<string, unknown>,
  url: string,
  headers: IncomingMessage["headers"],
  options: { onResponse?: (res: ServerResponse) => void } = {},
) {
  let output = ""
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage
  req.headers = headers
  req.method = "POST"
  req.url = url
  await new Promise<void>((resolve, reject) => {
    const closeListeners = new Set<(...args: unknown[]) => void>()
    const res = {
      emit(event: string, ...args: unknown[]) {
        if (event !== "close") return false
        const listeners = [...closeListeners]
        closeListeners.clear()
        for (const listener of listeners) listener(...args)
        return listeners.length > 0
      },
      statusCode: 200,
      end: (chunk?: unknown) => {
        if (chunk !== undefined) output += responseChunkText(chunk)
        resolve()
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        if (event === "close") closeListeners.delete(listener)
        return res
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        if (event === "close") closeListeners.add(listener)
        return res
      },
      setHeader: vi.fn(),
      write: (chunk: unknown) => {
        output += responseChunkText(chunk)
      },
    } as unknown as ServerResponse
    options.onResponse?.(res)
    handler(req, res, reject)
  })
  return output
}

async function createViteRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-"))
  tempDirs.push(rootDir)
  await mkdir(join(rootDir, "src"), { recursive: true })
  await mkdir(join(rootDir, "workspaces"), { recursive: true })
  await mkdir(join(rootDir, "node_modules", "@vite-hub", "workspace"), { recursive: true })
  await writeFile(join(rootDir, "node_modules", "@vite-hub", "workspace", "package.json"), JSON.stringify({
    exports: "./index.js",
    name: "@vite-hub/workspace",
    type: "module",
  }))
  await writeFile(join(rootDir, "node_modules", "@vite-hub", "workspace", "index.js"), `export const defineWorkspace = definition => definition\n`)
  await writeFile(join(rootDir, "src/docs.workspace.ts"), [
    `import { defineWorkspace } from "@vite-hub/workspace"`,
    `export default defineWorkspace({})`,
    ``,
  ].join("\n"))
  await writeFile(join(rootDir, "workspaces/ignored.ts"), [
    `import { defineWorkspace } from "@vite-hub/workspace"`,
    `export default defineWorkspace({})`,
    ``,
  ].join("\n"))
  return rootDir
}

async function createViteRootWithoutSrc() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-root-"))
  tempDirs.push(rootDir)
  await writeFile(join(rootDir, "docs.workspace.ts"), [
    `import { defineWorkspace } from "@vite-hub/workspace"`,
    `export default defineWorkspace({})`,
    ``,
  ].join("\n"))
  return rootDir
}

async function createViteAssetRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-assets-"))
  tempDirs.push(root)
  await mkdir(join(root, "src"), { recursive: true })
  for (const name of ["docs", "notes"]) {
    await writeFile(join(root, "src", `${name}.workspace.mjs`), [
      `export default {`,
      `  store: { provider: "memory" },`,
      `  sources: {`,
      `    files: {`,
      `      async getKeys() { return ["README.md"] },`,
      `      async getItem(key) { return { key, path: key, content: "${name}\\n" } },`,
      `    },`,
      `  },`,
      `}`,
      ``,
    ].join("\n"))
  }
  return root
}

afterEach(async () => {
  runWorkspaceDevCommand.mockClear()
  setWorkspaceHostedStoreLoader(undefined)
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("hubWorkspace", () => {
  it("runs before downstream framework integrations that consume Provider Output config", async () => {
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()

    expect(plugin.enforce).toBe("pre")
  })

  it("ignores generated workspace files in the Vite dev watcher", async () => {
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (config: { server?: { watch?: { ignored?: string | string[] } } }) => Promise<{ server?: { watch?: { ignored?: string[] } } }>

    await expect(config({})).resolves.toMatchObject({ server: { watch: { ignored: ["**/.vitehub/**"] } } })
    await expect(config({ server: { watch: { ignored: ["**/node_modules/**"] } } })).resolves.toMatchObject({ server: { watch: { ignored: [
      "**/node_modules/**",
      "**/.vitehub/**",
    ] } } })
    await expect(config({ server: { watch: { ignored: ["**/.vitehub/**"] } } })).resolves.toMatchObject({ server: { watch: { ignored: ["**/.vitehub/**"] } } })
  })

  it("attaches noExternal and virtual workspace manifests", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { root: string }) => Promise<void>
    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server", resolve?: { dedupe?: string[], noExternal?: string[] } }) => unknown
    const resolveId = plugin.resolveId as (id: string) => string | undefined
    const load = plugin.load as (id: string) => string | undefined

    await configResolved({ root } as never)

    expect(configEnvironment("ssr", { consumer: "server" })).toEqual({
      resolve: { dedupe: ["@vite-hub/workspace"], noExternal: ["@vite-hub/workspace"] },
    })
    expect(configEnvironment("ssr", {
      consumer: "server",
      resolve: {
        dedupe: ["existing"],
        noExternal: ["existing"],
      },
    })).toEqual({
      resolve: {
        dedupe: ["existing", "@vite-hub/workspace"],
        noExternal: ["existing", "@vite-hub/workspace"],
      },
    })
    await expect(readFile(join(root, ".vitehub", "types", "workspace.d.ts"), "utf8")).resolves.toContain('"docs": true')

    const rootId = resolveId("#vitehub/workspaces")!
    expect(load(rootId)).toContain('"docs"')
    expect(load(rootId)).not.toContain('"ignored"')
    const docsId = resolveId("#vitehub/workspaces/docs")!
    expect(load(docsId)).toContain('"entries":[]')
    const registryId = resolveId("#vitehub-workspace-registry")!
    expect(load(registryId)).toContain('"docs": async () => {')
    expect(load(registryId)).toContain("sourceRootDir")
  })

  it("normalizes Workspace Dev command definitions loaded from the Vite registry", async () => {
    const root = await createViteRoot()
    const handlers: Connect.NextHandleFunction[] = []
    const { hubWorkspace } = await import("../src/vite.ts")
    const { readWorkspaceDevToken, workspaceDevHeader, workspaceDevHeaderValue, workspaceDevRoute, workspaceDevTokenHeader, workspaceDevTokenServerId } = await import("../src/server.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "serve", root: string }) => Promise<void>

    await configResolved({ command: "serve", root })
    expect(getWorkspaceHostedStoreLoader()).toBeUndefined()
    await configurePluginServer(plugin, {
      config: { root, server: { port: 3000 } },
      middlewares: {
        use: vi.fn((handler: Connect.NextHandleFunction) => handlers.push(handler)),
      },
      resolvedUrls: { local: ["http://localhost:3000/"] },
      ssrLoadModule: vi.fn(async () => ({
        default: {
          docs: async () => ({ default: { store: { provider: "memory" } } }),
        },
      })),
      watcher: { on: vi.fn() },
    })
    expect(getWorkspaceHostedStoreLoader()).toEqual(expect.any(Function))
    const token = await readWorkspaceDevToken(root, { serverId: workspaceDevTokenServerId(3000) })

    await invokeMiddleware(handlers[0]!, {
      workspaceCommand: {
        args: ["test"],
        command: "pnpm",
        workspace: "docs",
      },
    }, workspaceDevRoute, {
      "content-type": "application/json",
      [workspaceDevHeader]: workspaceDevHeaderValue,
      [workspaceDevTokenHeader]: token,
    })

    expect(runWorkspaceDevCommand).toHaveBeenCalledWith(expect.objectContaining({
      args: ["test"],
      abortSignal: expect.any(AbortSignal),
      command: "pnpm",
      definition: expect.objectContaining({
        name: "docs",
        store: { provider: "memory" },
      }),
      workspace: "docs",
    }))
  })

  it("streams Workspace Dev command progress from the Vite endpoint", async () => {
    const root = await createViteRoot()
    const handlers: Connect.NextHandleFunction[] = []
    const { hubWorkspace } = await import("../src/vite.ts")
    const { readWorkspaceDevToken, workspaceDevHeader, workspaceDevHeaderValue, workspaceDevRoute, workspaceDevTokenHeader, workspaceDevTokenServerId } = await import("../src/server.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "serve", root: string }) => Promise<void>

    runWorkspaceDevCommand.mockImplementationOnce(async (input?: { onProgress?: (event: { id: string, label: string, status: "started" }) => void | Promise<void> }) => {
      await input?.onProgress?.({
        id: "workspace.dev.materialize",
        label: "Materializing workspace sources",
        status: "started",
      })
      return {
        exitCode: 0,
        stderr: "",
        stdout: "ok\n",
      }
    })

    await configResolved({ command: "serve", root })
    await configurePluginServer(plugin, {
      config: { root, server: { port: 3000 } },
      middlewares: {
        use: vi.fn((handler: Connect.NextHandleFunction) => handlers.push(handler)),
      },
      resolvedUrls: { local: ["http://localhost:3000/"] },
      ssrLoadModule: vi.fn(async () => ({
        default: {
          docs: async () => ({ default: { store: { provider: "memory" } } }),
        },
      })),
      watcher: { on: vi.fn() },
    })
    const token = await readWorkspaceDevToken(root, { serverId: workspaceDevTokenServerId(3000) })

    const output = await invokeMiddleware(handlers[0]!, {
      workspaceCommand: {
        command: "pnpm",
        workspace: "docs",
      },
    }, workspaceDevRoute, {
      accept: "application/x-ndjson",
      "content-type": "application/json",
      [workspaceDevHeader]: workspaceDevHeaderValue,
      [workspaceDevTokenHeader]: token,
    })

    const lines = output.trim().split("\n").map(line => JSON.parse(line))
    expect(lines).toEqual([
      {
        event: {
          id: "workspace.dev.materialize",
          label: "Materializing workspace sources",
          status: "started",
        },
        type: "progress",
      },
      {
        result: {
          exitCode: 0,
          stderr: "",
          stdout: "ok\n",
        },
        type: "result",
      },
    ])
  })

  it("aborts Workspace Dev commands when the client disconnects", async () => {
    const root = await createViteRoot()
    const handlers: Connect.NextHandleFunction[] = []
    const { hubWorkspace } = await import("../src/vite.ts")
    const { readWorkspaceDevToken, workspaceDevHeader, workspaceDevHeaderValue, workspaceDevRoute, workspaceDevTokenHeader, workspaceDevTokenServerId } = await import("../src/server.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "serve", root: string }) => Promise<void>
    let closeResponse: (() => void) | undefined
    let commandSignal: AbortSignal | undefined

    runWorkspaceDevCommand.mockImplementationOnce(async (input?: { abortSignal?: AbortSignal }) => {
      commandSignal = input?.abortSignal
      if (!commandSignal) throw new Error("Missing Workspace Dev abort signal.")
      const aborted = new Promise<void>((resolve) => {
        if (commandSignal?.aborted) resolve()
        else commandSignal?.addEventListener("abort", () => resolve(), { once: true })
      })
      closeResponse?.()
      await aborted
      return {
        exitCode: 130,
        stderr: "Command aborted",
        stdout: "",
      }
    })

    await configResolved({ command: "serve", root })
    await configurePluginServer(plugin, {
      config: { root, server: { port: 3000 } },
      middlewares: {
        use: vi.fn((handler: Connect.NextHandleFunction) => handlers.push(handler)),
      },
      resolvedUrls: { local: ["http://localhost:3000/"] },
      ssrLoadModule: vi.fn(async () => ({
        default: {
          docs: async () => ({ default: { store: { provider: "memory" } } }),
        },
      })),
      watcher: { on: vi.fn() },
    })
    const token = await readWorkspaceDevToken(root, { serverId: workspaceDevTokenServerId(3000) })

    const output = await invokeMiddleware(handlers[0]!, {
      workspaceCommand: {
        command: "pnpm",
        workspace: "docs",
      },
    }, workspaceDevRoute, {
      "content-type": "application/json",
      [workspaceDevHeader]: workspaceDevHeaderValue,
      [workspaceDevTokenHeader]: token,
    }, {
      onResponse(res) {
        closeResponse = () => (res as ServerResponse & { emit: (event: string) => boolean }).emit("close")
      },
    })

    expect(JSON.parse(output)).toMatchObject({
      exitCode: 130,
      stderr: "Command aborted",
      stdout: "",
    })
    expect(commandSignal).toBeInstanceOf(AbortSignal)
    expect(commandSignal?.aborted).toBe(true)
  })

  it("keeps ambient workspace types in generated ViteHub state without src", async () => {
    const root = await createViteRootWithoutSrc()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { root: string }) => Promise<void>

    await configResolved({ root } as never)

    await expect(readFile(join(root, ".vitehub", "types", "workspace.d.ts"), "utf8")).resolves.toContain('"docs": true')
  })

  it("discovers documented server workspace config files in the Vite integration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-server-"))
    tempDirs.push(root)
    await mkdir(join(root, "server", "workspaces", "tasks"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "tasks", "config.ts"), [
      `import { defineWorkspace } from "@vite-hub/workspace"`,
      `export default defineWorkspace({ store: { provider: "memory" } })`,
      ``,
    ].join("\n"))

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { root: string }) => Promise<void>
    const resolveId = plugin.resolveId as (id: string) => string | undefined
    const load = plugin.load as (id: string) => string | undefined

    await configResolved({ root } as never)

    await expect(readFile(join(root, ".vitehub", "types", "workspace.d.ts"), "utf8")).resolves.toContain('"tasks": true')
    expect(load(resolveId("#vitehub-workspace-registry")!)).toContain('"tasks": async () => {')
    expect(load(resolveId("#vitehub/workspaces")!)).toContain('"tasks"')
  })

  it("loads server workspace configs that import generated Env modules during build asset sync", async () => {
    const testRoot = join(process.cwd(), ".vitest-tmp")
    await mkdir(testRoot, { recursive: true })
    const root = await mkdtemp(join(testRoot, "vitehub-workspace-vite-env-"))
    tempDirs.push(root)
    await mkdir(join(root, "server", "workspaces", "tasks"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "tasks", "config.ts"), [
      `import { useServerEnv } from "#vitehub/env/server"`,
      `void useServerEnv`,
      `export default { store: { provider: "memory" }, sources: {} }`,
      ``,
    ].join("\n"))

    const { env, hubEnv } = await import("@vite-hub/env/vite")
    const envPlugin = hubEnv()
    // SAFETY: this focused test preserves the Env config hook's private state for configResolved.
    const envConfig = envPlugin.config as (config: { env?: unknown, root: string }, env: { command: "build", mode: string }) => Promise<Record<string, unknown>>
    const envConfigResolved = envPlugin.configResolved as unknown as (config: { logger: { info: () => void }, root: string }) => Promise<void>

    const envConfigResult = await envConfig({
      env: {
        server: {
          airtableToken: env({ secret: true }),
        },
      },
      root,
    }, { command: "build", mode: "production" })
    await envConfigResolved({
      ...envConfigResult,
      logger: { info: vi.fn() },
      root,
    })

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const buildStart = plugin.buildStart as () => Promise<void>

    await configResolved({ command: "build", root })
    await buildStart()

    await expect(readFile(join(root, ".vitehub", "vite-runtime", "workspace", "assets", "registry.mjs"), "utf8")).resolves.toContain('"tasks"')
  })

  it("uses the ViteHub project root for Nuxt app roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-nuxt-root-"))
    tempDirs.push(root)
    const appRoot = join(root, "app")
    await mkdir(join(root, "server", "workspaces", "mirror"), { recursive: true })
    await mkdir(appRoot, { recursive: true })
    await writeFile(join(root, "server", "workspaces", "mirror", "config.ts"), [
      `import { defineWorkspace } from "@vite-hub/workspace"`,
      `export default defineWorkspace({ store: { provider: "memory" } })`,
      ``,
    ].join("\n"))

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { nitro?: Record<string, unknown>, root: string, workspace?: Record<string, unknown> },
      env: { command: "serve", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>
    const configResolved = plugin.configResolved as (config: { command: "serve", root: string }) => Promise<void>
    const resolveId = plugin.resolveId as (id: string) => string | undefined
    const load = plugin.load as (id: string) => string | undefined

    await expect(config({ nitro: {}, root: appRoot, workspace: {} }, { command: "serve", mode: "development" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })
    await configResolved({ command: "serve", root: appRoot })

    await expect(readFile(join(root, ".vitehub", "types", "workspace.d.ts"), "utf8")).resolves.toContain('"mirror": true')
    await expect(readFile(join(appRoot, ".vitehub", "types", "workspace.d.ts"), "utf8")).rejects.toThrow()
    expect(load(resolveId("#vitehub-workspace-registry")!)).toContain('"mirror": async () => {')

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    const registrySource = await readFile(join(root, ".vitehub", "nitro", "workspace", "registry.js"), "utf8")
    expect(pluginSource).toContain("setWorkspaceRuntimeRegistry(registry)")
    expect(pluginSource).not.toContain("configureHostedWorkspaceRuntime")
    expect(registrySource).toContain('"mirror": async () => {')
    expect(registrySource).toContain("../../../server/workspaces/mirror/config.ts")
  })

  it("installs GitHub stores for discovered Nitro workspace definitions", async () => {
    const root = await createViteRoot()
    await mkdir(join(root, "server", "workspaces", "mirror"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "mirror", "config.ts"), [
      `import { defineWorkspace } from "@vite-hub/workspace"`,
      `export default defineWorkspace({`,
      `  store: { provider: "github", repository: "onmax/bitacora-de-vida", root: "/" },`,
      `})`,
      ``,
    ].join("\n"))

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { nitro?: Record<string, unknown>, root: string },
      env: { command: "serve", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>

    await expect(config({ nitro: {}, root }, { command: "serve", mode: "development" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("installHostedWorkspaceRuntime")
    expect(pluginSource).toContain("installHostedVercelBlobWorkspaceRuntime")
    expect(pluginSource).not.toContain("@vite-hub/workspace/internal/stores/github")
    expect(pluginSource).not.toContain("configureCloudflareWorkspaceRuntime")
  })

  it("installs hosted stores for discovered definitions with explicit local Nitro runtime config", async () => {
    const root = await createViteRoot()
    await mkdir(join(root, "server", "workspaces", "mirror"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "mirror", "config.ts"), [
      `import { defineWorkspace } from "@vite-hub/workspace"`,
      `export default defineWorkspace({`,
      `  store: { provider: "github", repository: "onmax/bitacora-de-vida", root: "/" },`,
      `})`,
      ``,
    ].join("\n"))

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { nitro?: { plugins?: string[] }, root: string, workspace?: { root?: string, store?: { provider: "local" } } },
      env: { command: "serve", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>

    await expect(config({
      root,
      workspace: {
        root: "server/workspaces",
        store: { provider: "local" },
      },
    }, { command: "serve", mode: "development" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("import { installHostedWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted'")
    expect(pluginSource).toContain("import { installHostedVercelBlobWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted-vercel-blob'")
    expect(pluginSource).toContain("import { setWorkspaceRuntimeConfig, setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/runtime'")
    expect(pluginSource).toContain("installHostedWorkspaceRuntime()")
    expect(pluginSource).toContain("installHostedVercelBlobWorkspaceRuntime()")
    expect(pluginSource).toContain("setWorkspaceRuntimeConfig")
    expect(pluginSource).toContain('"provider": "local"')
  })

  it("uses a configured package base in physical Nitro imports", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ importBase: "vite-hub/_internal/workspace" } as never)
    const config = plugin.config as (
      config: { nitro?: Record<string, unknown>, root: string },
      env: { command: "serve", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>

    await expect(config({ nitro: {}, root }, { command: "serve", mode: "development" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("from 'vite-hub/_internal/workspace/internal/runtime/hosted'")
    expect(pluginSource).toContain("from 'vite-hub/_internal/workspace/internal/runtime/hosted-vercel-blob'")
    expect(pluginSource).toContain("from 'vite-hub/_internal/workspace/runtime'")
    expect(pluginSource).not.toContain("@vite-hub/workspace")
  })

  it("uses the facade hosting hint for workspace defaults", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ hosting: "cloudflare-module" } as never)
    const config = plugin.config as (
      config: { nitro?: Record<string, unknown>, root: string },
      env: { command: "build", mode: string },
    ) => Promise<unknown>

    await config({ nitro: {}, root }, { command: "build", mode: "production" })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain('"provider": "memory"')
  })

  it.each(["netlify", "node-server"])("keeps the inferred local store implicit for %s hosting", async (hosting) => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ hosting } as never)
    const config = plugin.config as (
      config: { nitro?: Record<string, unknown>, root: string },
      env: { command: "build", mode: string },
    ) => Promise<unknown>

    await config({ nitro: {}, root }, { command: "build", mode: "production" })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).not.toContain("setWorkspaceRuntimeConfig")
    expect(pluginSource).not.toContain(root)
  })

  it("keeps Vite workspace names relative to nested Vite roots while writing project state", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-suffix-root-"))
    tempDirs.push(root)
    await mkdir(join(root, "frontend", "src"), { recursive: true })
    await mkdir(join(root, "server", "workspaces", "mirror"), { recursive: true })
    await writeFile(join(root, "frontend", "src", "docs.workspace.ts"), [
      `import { defineWorkspace } from "@vite-hub/workspace"`,
      `export default defineWorkspace({ store: { provider: "memory" } })`,
      ``,
    ].join("\n"))
    await writeFile(join(root, "server", "workspaces", "mirror", "config.ts"), [
      `export default { store: { provider: "memory" } }`,
      ``,
    ].join("\n"))

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>

    await configResolved({ command: "build", root: join(root, "frontend") })

    const types = await readFile(join(root, ".vitehub", "types", "workspace.d.ts"), "utf8")
    expect(types).toContain('"docs": true')
    expect(types).toContain('"mirror": true')
    expect(types).not.toContain('"frontend/src/docs": true')
    expect(plugin.api.getWorkspaces().map((workspace: { name: string }) => workspace.name).sort()).toEqual(["docs", "mirror"])
    await expect(readFile(join(root, "frontend", ".vitehub", "types", "workspace.d.ts"), "utf8")).rejects.toThrow()
  })

  it("emits Nitro runtime setup for hosted workspace stores outside server plugins", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { nitro?: { plugins?: string[] }, root: string, workspace?: { store?: { branch?: string, provider: "github", repository: string, root: string } } },
      env: { command: "build", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>
    const userConfig: Parameters<typeof config>[0] = {
      root,
      workspace: {
        store: {
          branch: "main",
          provider: "github",
          repository: "onmax/quiver-airtable",
          root: "app/server/workspaces/mirror",
        },
      },
    }

    await expect(config(userConfig, { command: "build", mode: "production" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })
    expect(userConfig.nitro).toMatchObject({ plugins: [".vitehub/nitro/workspace/plugin.ts"] })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("import { setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/runtime'")
    expect(pluginSource).toContain("import { configureHostedWorkspaceRuntime, installHostedWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted'")
    expect(pluginSource).toContain("import { installHostedVercelBlobWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted-vercel-blob'")
    expect(pluginSource).toContain("setWorkspaceRuntimeRegistry")
    expect(pluginSource).toContain("installHostedVercelBlobWorkspaceRuntime()")
    expect(pluginSource).toContain("import registry from \"./registry.js\"")
    expect(pluginSource).toContain('"provider": "github"')
    expect(pluginSource).toContain('"repository": "onmax/quiver-airtable"')
    await expect(readFile(join(root, "server", "plugins", "vitehub-workspace.ts"), "utf8")).rejects.toThrow()
  })

  it("preserves lazy GitHub store callbacks in generated Nitro runtime setup", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ hosting: "cloudflare-module" } as never)
    const config = plugin.config as (
      config: { nitro?: { plugins?: string[] }, root: string, workspace?: { store?: { provider: "github", repository?: () => string | undefined, root?: string, token?: () => string | undefined } } },
      env: { command: "build", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>
    const userConfig: Parameters<typeof config>[0] = {
      root,
      workspace: {
        store: {
          provider: "github",
          repository: () => process.env.WORKSPACE_REPO,
          root: "app/server/workspaces/mirror",
          token: () => process.env.WORKSPACE_TOKEN,
        },
      },
    }

    await expect(config(userConfig, { command: "build", mode: "production" })).resolves.toMatchObject({
      nitro: {
        cloudflare: { nodeCompat: true },
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
        rollupConfig: { external: ["cloudflare:workers"] },
      },
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("import { env as vitehubEnv } from 'cloudflare:workers'")
    expect(pluginSource).toContain("setActiveCloudflareEnv(vitehubEnv)")
    expect(pluginSource).toContain("configureHostedWorkspaceRuntime")
    expect(pluginSource).toContain('"repository": () => process.env.WORKSPACE_REPO')
    expect(pluginSource).toContain('"token": () => process.env.WORKSPACE_TOKEN')
    expect(pluginSource).not.toContain('"token": "********"')
  })

  it.each([
    ["VITEHUB_HOSTING", undefined],
    ["NITRO_PRESET", undefined],
    ["SERVER_PRESET", undefined],
    ["nitro.preset", { preset: "cloudflare-module" }],
  ] as const)("activates Cloudflare runtime bindings from %s", async (signal, nitro) => {
    const root = await createViteRoot()
    if (signal !== "nitro.preset") vi.stubEnv(signal, "cloudflare-module")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (config: {
      nitro?: { preset?: string }
      root: string
      workspace: { store: { provider: "github", repository: string } }
    }, env: { command: "build", mode: string }) => Promise<{ nitro?: { rollupConfig?: { external?: unknown } } }>

    const result = await config({
      ...(nitro ? { nitro } : {}),
      root,
      workspace: { store: { provider: "github", repository: "onmax/repo" } },
    }, { command: "build", mode: "production" })

    expect(result.nitro?.rollupConfig).toMatchObject({ external: ["cloudflare:workers"] })
    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("setActiveCloudflareEnv(vitehubEnv)")
  })

  it("falls through blank Cloudflare hosting signals", async () => {
    const root = await createViteRoot()
    vi.stubEnv("NITRO_PRESET", " ")
    vi.stubEnv("SERVER_PRESET", "cloudflare-module")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (config: {
      root: string
      workspace: { store: { provider: "github", repository: string } }
    }, env: { command: "build", mode: string }) => Promise<{ nitro?: { rollupConfig?: { external?: unknown } } }>

    const result = await config({
      root,
      workspace: { store: { provider: "github", repository: "onmax/repo" } },
    }, { command: "build", mode: "production" })

    expect(result.nitro?.rollupConfig).toMatchObject({ external: ["cloudflare:workers"] })
    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("setActiveCloudflareEnv(vitehubEnv)")
  })

  it("does not serialize absent or blank GitHub fallbacks over Cloudflare runtime bindings", async () => {
    const root = await createViteRoot()
    vi.stubEnv("GITHUB_REPOSITORY", "vite-hub/build-repository")
    vi.stubEnv("NITRO_PRESET", "cloudflare-module")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (config: {
      root: string
      workspace: { store: { branch: string, provider: "github", repo: string, root: string } }
    }, env: { command: "build", mode: string }) => Promise<unknown>

    await config({
      root,
      workspace: { store: { branch: " ", provider: "github", repo: " ", root: " " } },
    }, { command: "build", mode: "production" })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain('"provider": "github"')
    expect(pluginSource).not.toContain("vite-hub/build-repository")
    expect(pluginSource).not.toContain('"branch"')
    expect(pluginSource).not.toContain('"repository"')
    expect(pluginSource).not.toContain('".vitehub/workspaces/<workspace>"')
  })

  it("preserves build-time GitHub fallbacks for non-Cloudflare runtimes", async () => {
    const root = await createViteRoot()
    vi.stubEnv("GITHUB_REPOSITORY", "vite-hub/build-repository")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (config: {
      root: string
      workspace: { store: { provider: "github" } }
    }, env: { command: "build", mode: string }) => Promise<unknown>

    await config({
      root,
      workspace: { store: { provider: "github" } },
    }, { command: "build", mode: "production" })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain('"repository": "vite-hub/build-repository"')
    expect(pluginSource).not.toContain("setActiveCloudflareEnv")
  })

  it("emits Nitro hosted runtime setup for explicit Vercel Blob workspace stores", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { nitro?: { plugins?: string[] }, root: string, workspace?: { store?: { prefix?: string, provider: "vercel-blob" } } },
      env: { command: "build", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>
    const userConfig: Parameters<typeof config>[0] = {
      root,
      workspace: {
        store: {
          prefix: "workspaces",
          provider: "vercel-blob",
        },
      },
    }

    await expect(config(userConfig, { command: "build", mode: "production" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("import { configureHostedVercelBlobWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted-vercel-blob'")
    expect(pluginSource).toContain("import { installHostedWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted'")
    expect(pluginSource).toContain("import { setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/runtime'")
    expect(pluginSource).toContain("configureHostedVercelBlobWorkspaceRuntime")
    expect(pluginSource).toContain("installHostedWorkspaceRuntime()")
    expect(pluginSource).toContain('"provider": "vercel-blob"')
    expect(pluginSource).toContain('"prefix": "workspaces"')
    expect(pluginSource).not.toContain("setWorkspaceRuntimeConfig")
  })

  it("emits hosted Nitro runtime setup for env-default Vercel Blob workspace stores", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "runtime-token")
    vi.stubEnv("VITEHUB_WORKSPACE_BLOB_PREFIX", "workspace/default")
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { nitro?: { plugins?: string[] }, root: string },
      env: { command: "build", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>
    const userConfig: Parameters<typeof config>[0] = { root }

    await expect(config(userConfig, { command: "build", mode: "production" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("import { configureHostedVercelBlobWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted-vercel-blob'")
    expect(pluginSource).toContain("import { installHostedWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted'")
    expect(pluginSource).toContain("import { setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/runtime'")
    expect(pluginSource).toContain("configureHostedVercelBlobWorkspaceRuntime")
    expect(pluginSource).toContain("installHostedWorkspaceRuntime()")
    expect(pluginSource).toContain("setWorkspaceRuntimeRegistry")
    expect(pluginSource).not.toContain("setWorkspaceRuntimeConfig")
    expect(pluginSource).toContain('"provider": "vercel-blob"')
    expect(pluginSource).toContain('"prefix": "workspace/default"')
  })

  it("emits Nitro runtime setup for explicit local workspace stores", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { nitro?: { plugins?: string[] }, root: string, workspace?: { root?: string, store?: { provider: "local" } } },
      env: { command: "serve", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>
    const userConfig: Parameters<typeof config>[0] = {
      root,
      workspace: {
        root: "server/workspaces",
        store: { provider: "local" },
      },
    }

    await expect(config(userConfig, { command: "serve", mode: "development" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })
    expect(userConfig.nitro).toMatchObject({ plugins: [".vitehub/nitro/workspace/plugin.ts"] })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("setWorkspaceRuntimeConfig")
    expect(pluginSource).toContain("setWorkspaceRuntimeRegistry")
    expect(pluginSource).toContain("import registry from \"./registry.js\"")
    expect(pluginSource).toContain('"provider": "local"')
    expect(pluginSource).toContain(JSON.stringify(join(root, "server", "workspaces")))
    expect(pluginSource).not.toContain("configureHostedWorkspaceRuntime")
  })

  it("emits Nitro runtime setup when the Nitro Vite plugin is installed", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { plugins?: unknown[], root: string },
      env: { command: "serve", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>

    await expect(config({
      plugins: [{ name: "nitro:main" }],
      root,
    }, { command: "serve", mode: "development" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    const registrySource = await readFile(join(root, ".vitehub", "nitro", "workspace", "registry.js"), "utf8")
    expect(pluginSource).toContain("setWorkspaceRuntimeRegistry")
    expect(registrySource).toContain('"docs": async () => {')
  })

  it("activates Cloudflare Artifacts bindings in the Vite-generated Nitro runtime", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ store: { provider: "cloudflare-artifacts" } })
    const config = plugin.config as (
      config: { plugins?: unknown[], root: string },
      env: { command: "build", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>

    await expect(config({ plugins: [{ name: "nitro:main" }], root }, { command: "build", mode: "production" })).resolves.toMatchObject({
      nitro: {
        cloudflare: {
          nodeCompat: true,
          wrangler: {
            artifacts: [{ binding: "WORKSPACE_ARTIFACTS", namespace: "vitehub" }],
          },
        },
        rollupConfig: { external: ["cloudflare:workers"] },
      },
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("import { env as vitehubEnv } from 'cloudflare:workers'")
    expect(pluginSource).toContain("setActiveCloudflareEnv(vitehubEnv)")
  })

  it("preserves env-resolved Definition bindings in the Vite-generated registry", async () => {
    vi.stubEnv("WORKSPACE_ARTIFACTS_BINDING", "ENV_ARTIFACTS")
    const root = await createViteRoot()
    await writeFile(join(root, "src", "docs.workspace.ts"), "export default { store: { provider: 'cloudflare-artifacts' } }\n")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { plugins?: unknown[], root: string },
      env: { command: "build", mode: string },
    ) => Promise<unknown>

    await config({ plugins: [{ name: "nitro:main" }], root }, { command: "build", mode: "production" })

    const registry = await readFile(join(root, ".vitehub", "nitro", "workspace", "registry.js"), "utf8")
    expect(registry).toContain('store: {"binding":"ENV_ARTIFACTS"')
  })

  it("does not discover Nitro workspaces when workspace is disabled", async () => {
    const root = await createViteRoot()
    const { createWorkspaceNitroConfig } = await import("../src/vite.ts")

    await expect(createWorkspaceNitroConfig({
      viteRoot: root,
      workspace: false,
    })).resolves.toBe(null)
    await expect(readFile(join(root, ".vitehub", "nitro", "workspace", "registry.js"), "utf8")).rejects.toThrow()
  })

  it("exposes standalone Nitro config through the Nitro subpath", async () => {
    const root = await createViteRoot()
    const { createWorkspaceNitroConfig } = await import("../src/nitro.ts")

    await expect(createWorkspaceNitroConfig({ viteRoot: root })).resolves.toMatchObject({
      plugins: [".vitehub/nitro/workspace/plugin.ts"],
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("export default function vitehubWorkspacePlugin() {")
    expect(pluginSource).not.toContain("from 'nitro'")
    expect(pluginSource).not.toContain("nitropack/runtime")
  })

  it("activates standalone Nitro Cloudflare bindings from the provided environment", async () => {
    const root = await createViteRoot()
    const { createWorkspaceNitroConfig } = await import("../src/nitro.ts")

    await expect(createWorkspaceNitroConfig({
      env: { NITRO_PRESET: "cloudflare-module" },
      viteRoot: root,
    })).resolves.toMatchObject({
      rollupConfig: { external: ["cloudflare:workers"] },
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("setActiveCloudflareEnv(vitehubEnv)")
  })

  it("uses discovered source roots from generated Nitro workspace registries", async () => {
    const testRoot = join(process.cwd(), "..", "..", ".vitest-tmp")
    await mkdir(testRoot, { recursive: true })
    const root = await mkdtemp(join(testRoot, "vitehub-workspace-nitro-source-root-"))
    tempDirs.push(root)
    await mkdir(join(root, "server", "workspaces", "sync"), { recursive: true })
    await writeFile(join(root, "source.md"), "PROJECT_ROOT_FALLBACK_SHOULD_NOT_BE_READ\n")
    await writeFile(join(root, "server", "workspaces", "sync", "source.md"), "COLOCATED_SOURCE_SYNC_OK\n")
    await writeFile(join(root, "server", "workspaces", "sync", "config.ts"), [
      `import { defineWorkspace, file } from "@vite-hub/workspace"`,
      `export default defineWorkspace({`,
      `  store: { provider: "memory" },`,
      `  sources: {`,
      `    colocated: file({ path: "source.md", workspacePath: "synced/source.md", sync: true }),`,
      `  },`,
      `})`,
      ``,
    ].join("\n"))

    const { createWorkspaceNitroConfig } = await import("../src/vite.ts")
    await expect(createWorkspaceNitroConfig({ viteRoot: root })).resolves.toMatchObject({
      plugins: [".vitehub/nitro/workspace/plugin.ts"],
    })

    const registry = (await import(`${pathToFileURL(join(root, ".vitehub", "nitro", "workspace", "registry.js")).href}?t=${Date.now()}`)).default
    const { resetWorkspaceRegistry } = await import("../src/core/registry.ts")
    const { setWorkspaceRuntimeRegistry, useWorkspace } = await import("../src/runtime.ts")
    setWorkspaceRuntimeRegistry(registry)
    try {
      const workspace = useWorkspace("sync", { mode: "write" })
      await workspace.sync({ sources: ["colocated"] })
      await expect(workspace.fs.readFile("synced/source.md", { encoding: "utf8" })).resolves.toBe("COLOCATED_SOURCE_SYNC_OK\n")
    }
    finally {
      resetWorkspaceRegistry()
    }
  })

  it("keeps generated workspace files in project ViteHub state when Vite root is app", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-app-root-"))
    tempDirs.push(root)
    await mkdir(join(root, "app"), { recursive: true })
    await mkdir(join(root, "server", "workspaces", "mirror"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "mirror", "config.ts"), [
      `export default { store: { provider: "memory" } }`,
      ``,
    ].join("\n"))

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { root: string, workspace?: { store?: { branch?: string, provider: "github", repository: string, root: string } } },
      env: { command: "build", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>

    await expect(config({
      root: join(root, "app"),
      workspace: {
        store: {
          branch: "main",
          provider: "github",
          repository: "onmax/quiver-airtable",
          root: "server/workspaces/mirror",
        },
      },
    }, { command: "build", mode: "production" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    await expect(readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")).resolves.toContain("configureHostedWorkspaceRuntime")
    await expect(readFile(join(root, "app", ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, ".vitehub", "nitro", "workspace", "registry.js"), "utf8")).resolves.toContain('"mirror": async () => {')
  })

  it("keeps generated workspace files in project ViteHub state when Vite root is nested", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-nested-root-"))
    tempDirs.push(root)
    await mkdir(join(root, "frontend"), { recursive: true })
    await mkdir(join(root, "server", "workspaces", "mirror"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "mirror", "config.ts"), [
      `export default { store: { provider: "memory" } }`,
      ``,
    ].join("\n"))

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { root: string, workspace?: { store?: { branch?: string, provider: "github", repository: string, root: string } } },
      env: { command: "build", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>

    await expect(config({
      root: join(root, "frontend"),
      workspace: {
        store: {
          branch: "main",
          provider: "github",
          repository: "onmax/quiver-airtable",
          root: "server/workspaces/mirror",
        },
      },
    }, { command: "build", mode: "production" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    await expect(readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")).resolves.toContain("configureHostedWorkspaceRuntime")
    await expect(readFile(join(root, "frontend", ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, ".vitehub", "nitro", "workspace", "registry.js"), "utf8")).resolves.toContain('"mirror": async () => {')
  })

  it("materializes the workspace runtime package for Vercel build output", async () => {
    const root = await createViteRoot()
    const { copyVercelFunctionRuntimePackages } = await import("@vite-hub/internal/build/vercel-runtime-packages")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
    vi.mocked(copyVercelFunctionRuntimePackages).mockClear()

    await configResolved({ command: "build", root })
    await closeBundle.handler()

    expect(copyVercelFunctionRuntimePackages).toHaveBeenCalledWith({
      packages: [{ name: "@vite-hub/workspace", resolveFrom: expect.any(String) }],
      rootDir: root,
    })
  })

  it("materializes @vercel/blob for Vercel Blob workspace build output", async () => {
    const root = await createViteRoot()
    const { copyVercelFunctionRuntimePackages } = await import("@vite-hub/internal/build/vercel-runtime-packages")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({
      store: {
        provider: "vercel-blob",
      },
    })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
    vi.mocked(copyVercelFunctionRuntimePackages).mockClear()

    await configResolved({ command: "build", root })
    await closeBundle.handler()

    expect(copyVercelFunctionRuntimePackages).toHaveBeenCalledWith({
      packages: [
        { name: "@vite-hub/workspace", resolveFrom: expect.any(String) },
        { name: "@vercel/blob" },
      ],
      rootDir: root,
    })
  })

  it("materializes @vercel/blob for definition-level Vercel Blob workspace build output", async () => {
    const root = await createViteRoot()
    await writeFile(join(root, "src/docs.workspace.ts"), [
      `import { defineWorkspace } from "@vite-hub/workspace"`,
      `export default defineWorkspace({`,
      `  store: { provider: "vercel-blob" },`,
      `})`,
    ].join("\n"))
    const { copyVercelFunctionRuntimePackages } = await import("@vite-hub/internal/build/vercel-runtime-packages")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
    vi.mocked(copyVercelFunctionRuntimePackages).mockClear()

    await configResolved({ command: "build", root })
    await closeBundle.handler()

    expect(copyVercelFunctionRuntimePackages).toHaveBeenCalledWith({
      packages: [
        { name: "@vite-hub/workspace", resolveFrom: expect.any(String) },
        { name: "@vercel/blob" },
      ],
      rootDir: root,
    })
  })

  it("merges explicit Cloudflare Artifacts bindings into provider output", async () => {
    const root = await createViteRoot()
    const { createDefaultCloudflareOutputRoot } = await import("@vite-hub/internal/build/cloudflare")
    const outputRoot = createDefaultCloudflareOutputRoot(root)
    await mkdir(outputRoot, { recursive: true })
    await writeFile(join(outputRoot, "wrangler.json"), `${JSON.stringify({
      artifacts: [{ binding: "APP_ARTIFACTS", namespace: "app" }],
      d1_databases: [{ binding: "DB", database_id: "database-id", database_name: "app" }],
    }, null, 2)}\n`, "utf8")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({
      store: {
        binding: "WORKSPACE_FILES",
        namespace: "workspaces",
        provider: "cloudflare-artifacts",
      },
    })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }

    await configResolved({ command: "build", root })
    await closeBundle.handler()

    const wrangler = JSON.parse(await readFile(join(outputRoot, "wrangler.json"), "utf8"))
    expect(wrangler).toEqual({
      artifacts: [
        { binding: "APP_ARTIFACTS", namespace: "app" },
        { binding: "WORKSPACE_FILES", namespace: "workspaces" },
      ],
      d1_databases: [{ binding: "DB", database_id: "database-id", database_name: "app" }],
    })
  })

  it("resolves definition-level Cloudflare Artifacts bindings without inspecting source text", async () => {
    const root = await createViteRoot()
    await writeFile(join(root, "src", "workspace-store.mjs"), [
      `export const store = {`,
      `  binding: "DEFINITION_FILES",`,
      `  namespace: "definition-workspaces",`,
      `  provider: "cloudflare-artifacts",`,
      `}`,
      ``,
    ].join("\n"))
    await writeFile(join(root, "src", "docs.workspace.ts"), [
      `import { store } from "./workspace-store.mjs"`,
      `export default { store }`,
      ``,
    ].join("\n"))
    const { createDefaultCloudflareOutputRoot } = await import("@vite-hub/internal/build/cloudflare")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }

    await configResolved({ command: "build", root })
    await closeBundle.handler()

    const wrangler = JSON.parse(await readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8"))
    expect(wrangler.artifacts).toEqual([
      { binding: "DEFINITION_FILES", namespace: "definition-workspaces" },
    ])
  })

  it("resolves definition-level Cloudflare Artifacts bindings through raw text imports", async () => {
    const root = await createViteRoot()
    await writeFile(join(root, "src", "repository-host-context.md"), "definition-workspaces\n")
    await writeFile(join(root, "src", "repository-host-context.ts"), [
      `import repositoryHostContext from "./repository-host-context.md?raw"`,
      `export const namespace = repositoryHostContext.trim()`,
      ``,
    ].join("\n"))
    await writeFile(join(root, "src", "docs.workspace.ts"), [
      `import { namespace } from "./repository-host-context.ts"`,
      `export default {`,
      `  store: { binding: "DEFINITION_FILES", namespace, provider: "cloudflare-artifacts" },`,
      `}`,
      ``,
    ].join("\n"))
    const { createDefaultCloudflareOutputRoot } = await import("@vite-hub/internal/build/cloudflare")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }

    await configResolved({ command: "build", root })
    await closeBundle.handler()

    const wrangler = JSON.parse(await readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8"))
    expect(wrangler.artifacts).toEqual([
      { binding: "DEFINITION_FILES", namespace: "definition-workspaces" },
    ])
  })

  it("does not import Workspace Definitions when build-time assets are disabled", async () => {
    const root = await createViteRoot()
    await writeFile(join(root, "src", "docs.workspace.ts"), [
      `import store from "#generated-workspace-store"`,
      `export default { store }`,
      ``,
    ].join("\n"))
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ assets: false, store: { provider: "memory" } })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }

    await configResolved({ command: "build", root })

    await expect(closeBundle.handler()).resolves.toBeUndefined()
  })

  it("emits aliased definition-level Cloudflare Artifacts bindings when assets are disabled", async () => {
    const root = await createViteRoot()
    await writeFile(join(root, "src", "workspace-store.ts"), [
      `export const store = {`,
      `  binding: "DEFINITION_FILES",`,
      `  namespace: "definition-workspaces",`,
      `  provider: "cloudflare-artifacts",`,
      `}`,
      ``,
    ].join("\n"))
    await writeFile(join(root, "src", "docs.workspace.ts"), [
      `import { store } from "@/workspace-store"`,
      `export default { store }`,
      ``,
    ].join("\n"))
    const { createDefaultCloudflareOutputRoot } = await import("@vite-hub/internal/build/cloudflare")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ assets: false, projectRoot: "." })
    const configResolved = plugin.configResolved as (config: {
      command: "build"
      createResolver: () => (id: string) => Promise<string | undefined>
      resolve: { alias: Array<{ find: string, replacement: string }> }
      root: string
    }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }

    await configResolved({
      command: "build",
      createResolver: () => async id => id.startsWith("@/") ? join(root, "src", id.slice(2)) : undefined,
      resolve: { alias: [{ find: "@", replacement: join(root, "src") }] },
      root,
    })
    await closeBundle.handler()

    const wrangler = JSON.parse(await readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8"))
    expect(wrangler.artifacts).toEqual([
      { binding: "DEFINITION_FILES", namespace: "definition-workspaces" },
    ])
  })

  it.each([false, ["notes"]] as Array<false | string[]>)("emits definition-level Cloudflare Artifacts bindings independently of asset selection", async (assets) => {
    const root = await createViteRoot()
    await writeFile(join(root, "src", "docs.workspace.ts"), [
      `export default {`,
      `  store: { binding: "DEFINITION_FILES", namespace: "definition-workspaces", provider: "cloudflare-artifacts" },`,
      `}`,
      ``,
    ].join("\n"))
    const { createDefaultCloudflareOutputRoot } = await import("@vite-hub/internal/build/cloudflare")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ assets, projectRoot: "." })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }

    await configResolved({ command: "build", root })
    await closeBundle.handler()

    const wrangler = JSON.parse(await readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8"))
    expect(wrangler.artifacts).toEqual([
      { binding: "DEFINITION_FILES", namespace: "definition-workspaces" },
    ])
  })

  it.each([
    {
      definition: `export default { "store": { "binding": "DEFINITION_FILES", "namespace": "definition-workspaces", "provider": "cloudflare-artifacts" } }\n`,
      files: {},
      name: "quoted object keys",
    },
    {
      definition: `import { workspaceStore } from "./workspace-store.mjs"\nexport default { store: workspaceStore() }\n`,
      files: {
        "workspace-store.mjs": `export function workspaceStore() { return { binding: "DEFINITION_FILES", namespace: "definition-workspaces", provider: ["cloudflare", "artifacts"].join("-") } }\n`,
      },
      name: "helper-returned options",
    },
  ])("emits definition-level Cloudflare Artifacts bindings from $name when assets are disabled", async ({ definition, files }) => {
    const root = await createViteRoot()
    await writeFile(join(root, "src", "docs.workspace.ts"), definition)
    await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(join(root, "src", name), contents)))
    const { createDefaultCloudflareOutputRoot } = await import("@vite-hub/internal/build/cloudflare")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ assets: false })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }

    await configResolved({ command: "build", root })
    await closeBundle.handler()

    const wrangler = JSON.parse(await readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8"))
    expect(wrangler.artifacts).toEqual([
      { binding: "DEFINITION_FILES", namespace: "definition-workspaces" },
    ])
  })

  it("reuses an exact app-owned Cloudflare Artifacts binding without claiming it", async () => {
    const root = await createViteRoot()
    const { createDefaultCloudflareOutputRoot } = await import("@vite-hub/internal/build/cloudflare")
    const outputRoot = createDefaultCloudflareOutputRoot(root)
    await mkdir(outputRoot, { recursive: true })
    await writeFile(join(outputRoot, "wrangler.json"), `${JSON.stringify({
      artifacts: [{ binding: "WORKSPACE_FILES", namespace: "workspaces" }],
    }, null, 2)}\n`, "utf8")
    const { hubWorkspace } = await import("../src/vite.ts")

    const enabledPlugin = hubWorkspace({
      store: { binding: "WORKSPACE_FILES", namespace: "workspaces", provider: "cloudflare-artifacts" },
    })
    await (enabledPlugin.configResolved as (config: { command: "build", root: string }) => Promise<void>)({ command: "build", root })
    await (enabledPlugin.closeBundle as { handler: () => Promise<void> }).handler()

    const disabledPlugin = hubWorkspace({ store: { provider: "memory" } })
    await (disabledPlugin.configResolved as (config: { command: "build", root: string }) => Promise<void>)({ command: "build", root })
    await (disabledPlugin.closeBundle as { handler: () => Promise<void> }).handler()

    await expect(readFile(join(outputRoot, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      artifacts: [{ binding: "WORKSPACE_FILES", namespace: "workspaces" }],
    })
  })

  it("rejects collisions with app-owned Cloudflare Artifacts bindings", async () => {
    const root = await createViteRoot()
    const { createDefaultCloudflareOutputRoot } = await import("@vite-hub/internal/build/cloudflare")
    const outputRoot = createDefaultCloudflareOutputRoot(root)
    await mkdir(outputRoot, { recursive: true })
    await writeFile(join(outputRoot, "wrangler.json"), `${JSON.stringify({
      artifacts: [{ binding: "WORKSPACE_FILES", namespace: "app" }],
    }, null, 2)}\n`, "utf8")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({
      store: { binding: "WORKSPACE_FILES", namespace: "workspaces", provider: "cloudflare-artifacts" },
    })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }

    await configResolved({ command: "build", root })

    await expect(closeBundle.handler()).rejects.toThrow(
      'Cloudflare Artifacts binding "WORKSPACE_FILES" already exists in Wrangler config with namespace "app", but Workspace requested namespace "workspaces"',
    )
    await expect(readFile(join(outputRoot, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      artifacts: [{ binding: "WORKSPACE_FILES", namespace: "app" }],
    })
  })

  it("rejects Cloudflare Artifacts binding conflicts across Workspace configs", async () => {
    const root = await createViteRoot()
    await writeFile(join(root, "src", "docs.workspace.ts"), [
      `export default {`,
      `  store: { binding: "WORKSPACE_FILES", namespace: "definition", provider: "cloudflare-artifacts" },`,
      `}`,
      ``,
    ].join("\n"))
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({
      store: { binding: "WORKSPACE_FILES", namespace: "module", provider: "cloudflare-artifacts" },
    })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }

    await configResolved({ command: "build", root })

    await expect(closeBundle.handler()).rejects.toThrow(
      'Cloudflare Artifacts binding "WORKSPACE_FILES" cannot use both namespace "module" and "definition"',
    )
  })

  it("replaces and removes only Workspace-owned Cloudflare Artifacts bindings", async () => {
    const root = await createViteRoot()
    const { createDefaultCloudflareOutputRoot } = await import("@vite-hub/internal/build/cloudflare")
    const outputRoot = createDefaultCloudflareOutputRoot(root)
    await mkdir(outputRoot, { recursive: true })
    await writeFile(join(outputRoot, "wrangler.json"), `${JSON.stringify({
      artifacts: [{ binding: "APP_ARTIFACTS", namespace: "app" }],
    }, null, 2)}\n`, "utf8")
    const { hubWorkspace } = await import("../src/vite.ts")

    const oldPlugin = hubWorkspace({
      store: { binding: "OLD_WORKSPACE_FILES", namespace: "old", provider: "cloudflare-artifacts" },
    })
    await (oldPlugin.configResolved as (config: { command: "build", root: string }) => Promise<void>)({ command: "build", root })
    await (oldPlugin.closeBundle as { handler: () => Promise<void> }).handler()

    const newPlugin = hubWorkspace({
      store: { binding: "NEW_WORKSPACE_FILES", namespace: "new", provider: "cloudflare-artifacts" },
    })
    await (newPlugin.configResolved as (config: { command: "build", root: string }) => Promise<void>)({ command: "build", root })
    await (newPlugin.closeBundle as { handler: () => Promise<void> }).handler()

    await expect(readFile(join(outputRoot, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      artifacts: [
        { binding: "APP_ARTIFACTS", namespace: "app" },
        { binding: "NEW_WORKSPACE_FILES", namespace: "new" },
      ],
    })

    const disabledPlugin = hubWorkspace({ store: { provider: "memory" } })
    await (disabledPlugin.configResolved as (config: { command: "build", root: string }) => Promise<void>)({ command: "build", root })
    await (disabledPlugin.closeBundle as { handler: () => Promise<void> }).handler()

    await expect(readFile(join(outputRoot, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      artifacts: [{ binding: "APP_ARTIFACTS", namespace: "app" }],
    })
  })

  it("leaves e2e hosted output to the e2e composer", async () => {
    const root = await createViteRoot()
    const { copyVercelFunctionRuntimePackages } = await import("@vite-hub/internal/build/vercel-runtime-packages")
    const { VITEHUB_VITE_MODE_KEY } = await import("@vite-hub/internal/build/mode")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
    vi.mocked(copyVercelFunctionRuntimePackages).mockClear()
    vi.stubEnv(VITEHUB_VITE_MODE_KEY, "e2e")

    await configResolved({ command: "build", root })
    await closeBundle.handler()

    expect(copyVercelFunctionRuntimePackages).not.toHaveBeenCalled()
  })

  it("emits build-time workspace assets for Vite builds", async () => {
    const root = await createViteAssetRoot()

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const buildStart = plugin.buildStart as () => Promise<void>
    const resolveId = plugin.resolveId as (id: string) => string | undefined

    await configResolved({ command: "build", root })
    await buildStart()

    const registryId = resolveId("#vitehub-workspace-assets-registry")!
    const registry = (await import(`${pathToFileURL(registryId).href}?t=${Date.now()}`)).default

    await expect(readFile(registryId, "utf8")).resolves.toContain('"docs"')
    await expect(readFile(registryId, "utf8")).resolves.toContain('"notes"')
    await expect(registry.docs.list()).resolves.toEqual([
      expect.objectContaining({ path: "files", type: "directory" }),
    ])
    await expect(registry.docs.readFile("files/README.md")).resolves.toBe("docs\n")
    await expect(registry.notes.readFile("files/README.md")).resolves.toBe("notes\n")
  })

  it("emits selected build-time workspace assets for Vite builds", async () => {
    const root = await createViteAssetRoot()

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ assets: ["docs"] })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const buildStart = plugin.buildStart as () => Promise<void>
    const resolveId = plugin.resolveId as (id: string) => string | undefined

    await configResolved({ command: "build", root })
    await buildStart()

    const registryId = resolveId("#vitehub-workspace-assets-registry")!
    const registry = (await import(`${pathToFileURL(registryId).href}?t=${Date.now()}`)).default

    await expect(readFile(registryId, "utf8")).resolves.toContain('"docs"')
    await expect(readFile(registryId, "utf8")).resolves.not.toContain('"notes"')
    await expect(registry.docs.readFile("files/README.md")).resolves.toBe("docs\n")
    expect(registry.notes).toBeUndefined()
  })

  it("can disable build-time workspace assets for Vite builds", async () => {
    const root = await createViteAssetRoot()

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ assets: false })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const buildStart = plugin.buildStart as () => Promise<void>
    const resolveId = plugin.resolveId as (id: string) => string | undefined

    await configResolved({ command: "build", root })
    await buildStart()

    const registryId = resolveId("#vitehub-workspace-assets-registry")!
    const registry = (await import(`${pathToFileURL(registryId).href}?t=${Date.now()}`)).default

    await expect(readFile(registryId, "utf8")).resolves.not.toContain('"docs"')
    await expect(readFile(registryId, "utf8")).resolves.not.toContain('"notes"')
    expect(registry).toEqual({})
  })

  it("lets Vite config override direct integration options", async () => {
    const root = await createViteAssetRoot()

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ assets: ["docs"] })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string, workspace?: { assets?: boolean | string[] } }) => Promise<void>
    const buildStart = plugin.buildStart as () => Promise<void>
    const resolveId = plugin.resolveId as (id: string) => string | undefined

    await configResolved({ command: "build", root, workspace: { assets: false } })
    await buildStart()

    const registryId = resolveId("#vitehub-workspace-assets-registry")!
    const registry = (await import(`${pathToFileURL(registryId).href}?t=${Date.now()}`)).default

    await expect(readFile(registryId, "utf8")).resolves.not.toContain('"docs"')
    await expect(readFile(registryId, "utf8")).resolves.not.toContain('"notes"')
    expect(registry).toEqual({})
  })
})
