import { once } from "node:events"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { resolveRegisteredWorkspaceDefinition } from "@vite-hub/workspace/runtime"
import { hubWorkspace } from "@vite-hub/workspace/vite"
import { createServer, DevEnvironment } from "vite"
import { afterEach, expect, it, vi } from "vitest"

import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } from "../src/invocation-stream.ts"
import { devModuleRunners } from "../src/vite/dev-module-runners.ts"
import { hubAgent } from "../src/vite.ts"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const agentSource = `import { defineAgent } from "@vite-hub/agent"
import { name } from "../../shared/name.ts"

export default defineAgent({ name, driver: { model: "openai/gpt-5.1" } })
`

// Nuxt 5 gives the `ssr` environment to the Vue renderer in Nitro's worker. It has no runner, so `ssrLoadModule()` throws.
it("discovers Agents when the ssr environment cannot run modules, and reloads an edited Agent import", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-dev-nuxt-ssr-"))
  cleanups.push(() => rm(root, { force: true, recursive: true }))
  const nameFile = join(root, "shared/name.ts")
  await mkdir(join(root, "server/agents"), { recursive: true })
  await mkdir(join(root, "shared"), { recursive: true })
  await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
  await symlink(fileURLToPath(new URL("..", import.meta.url)), join(root, "node_modules/@vite-hub/agent"), "dir")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-dev-nuxt-ssr", type: "module" }))
  await writeFile(join(root, "server/agents/greeter.ts"), agentSource)
  await writeFile(nameFile, `export const name = "hello"\n`)

  const server = await createServer({
    appType: "custom",
    configFile: false,
    environments: {
      ssr: { dev: { createEnvironment: (name, config) => new DevEnvironment(name, config, { hot: false }) } },
    },
    logLevel: "silent",
    plugins: [hubAgent()],
    root,
    server: { middlewareMode: true },
  })
  cleanups.push(() => server.close())
  expect("runner" in server.environments.ssr!).toBe(false)
  const http = createHttpServer(server.middlewares).listen(0, "127.0.0.1")
  cleanups.push(async () => { http.close() })
  await once(http, "listening")
  const address = http.address()
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  const url = `http://127.0.0.1:${address.port}${agentInvocationStreamRoute}`
  const discover = async () => {
    const response = await fetch(url, { headers: { accept: "application/json", [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue } })
    return { body: await response.text(), status: response.status }
  }

  const first = await discover()
  expect(first.status, first.body).toBe(200)
  expect(JSON.parse(first.body).agents).toEqual([expect.objectContaining({ aliases: ["hello"], name: "greeter" })])

  // On Nuxt 5, Nitro's worker shares this module graph and transforms an edited file again before the Dev Loop asks.
  const environment = server.environments.ssr!
  const [nameModule] = environment.moduleGraph.getModulesByFile(nameFile) ?? []
  expect(nameModule?.transformResult).toBeTruthy()
  await writeFile(nameFile, `export const name = "hi"\n`)
  await vi.waitFor(() => expect(nameModule!.transformResult).toBeNull(), { interval: 50, timeout: 10_000 })
  await environment.transformRequest(nameModule!.url)

  const edited = await discover()
  expect(JSON.parse(edited.body).agents).toEqual([expect.objectContaining({ aliases: ["hi"], name: "greeter" })])
}, 30_000)

// Nuxt 5 loads the Workspace registry through the `nitro` environment. A Workspace added after the first load must reach
// the Dev Loop without a restart, and the Dev Loop must release its module runner when the server closes.
it("refreshes the Workspace registry in the nitro environment, and releases the module runner on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-dev-nuxt-workspace-"))
  cleanups.push(() => rm(root, { force: true, recursive: true }))
  await mkdir(join(root, "server/agents"), { recursive: true })
  await mkdir(join(root, "server/workspaces"), { recursive: true })
  await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
  await symlink(fileURLToPath(new URL("..", import.meta.url)), join(root, "node_modules/@vite-hub/agent"), "dir")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-dev-nuxt-workspace", type: "module" }))
  await writeFile(join(root, "server/agents/greeter.ts"), `import { defineAgent } from "@vite-hub/agent"\nexport default defineAgent({ driver: { model: "openai/gpt-5.1" } })\n`)
  await writeFile(join(root, "server/workspaces/first.ts"), `export default { sourceRootDir: "first" }\n`)

  const runnerEnvironment = (name: string, config: ConstructorParameters<typeof DevEnvironment>[1]) => new DevEnvironment(name, config, { hot: false })
  const server = await createServer({
    appType: "custom",
    configFile: false,
    environments: {
      nitro: { consumer: "server", dev: { createEnvironment: runnerEnvironment } },
      ssr: { dev: { createEnvironment: runnerEnvironment } },
    },
    logLevel: "silent",
    plugins: [hubWorkspace(), hubAgent()],
    root,
    server: { middlewareMode: true },
  })
  let closed = false
  cleanups.push(async () => { if (!closed) await server.close() })
  const http = createHttpServer(server.middlewares).listen(0, "127.0.0.1")
  cleanups.push(async () => { http.close() })
  await once(http, "listening")
  const address = http.address()
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  const url = `http://127.0.0.1:${address.port}${agentInvocationStreamRoute}`
  const discover = async () => {
    const response = await fetch(url, { headers: { accept: "application/json", [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue } })
    const body = await response.text()
    expect(response.status, body).toBe(200)
  }

  await discover()
  await expect(resolveRegisteredWorkspaceDefinition("first")).resolves.toMatchObject({ name: "first" })
  const registryId = "\0#vitehub-workspace-registry"
  expect(server.environments.nitro!.moduleGraph.getModuleById(registryId)?.transformResult).toBeTruthy()

  await writeFile(join(root, "server/workspaces/later.ts"), `export default { sourceRootDir: "later" }\n`)
  await vi.waitFor(() => expect(server.environments.nitro!.moduleGraph.getModuleById(registryId)?.transformResult).toBeNull(), { interval: 50, timeout: 10_000 })
  await discover()
  await expect(resolveRegisteredWorkspaceDefinition("later")).resolves.toMatchObject({ name: "later" })

  // The runner keeps its modules in Vite's process-wide source map set and patches `Error.prepareStackTrace` until it closes.
  const runner = devModuleRunners.get(server.environments.nitro!)?.runner
  expect(runner?.isClosed()).toBe(false)
  await server.close()
  closed = true
  expect(runner?.isClosed()).toBe(true)
  expect(devModuleRunners.has(server.environments.nitro!)).toBe(false)
}, 30_000)
