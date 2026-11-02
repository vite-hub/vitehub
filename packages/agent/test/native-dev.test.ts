import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"
import { importOptionalKV, installAgentKV } from "../src/internal/optional-kv.ts"
import { hubAgent } from "../src/vite.ts"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))) })

type ConfigEnvironmentHook = (name: string, config: { consumer: string }, env: { command: string }) => { resolve?: { noExternal?: unknown } }

describe("Agent package in vite dev", () => {
  it("lets Node load the package in the Nitro environment of vite dev", () => {
    // SAFETY: The hook reads only the environment name, consumer, and command, which these fixtures supply.
    const configEnvironment = hubAgent().configEnvironment as ConfigEnvironmentHook
    expect(configEnvironment("nitro", { consumer: "server" }, { command: "serve" }).resolve).toBeUndefined()
    expect(configEnvironment("nitro", { consumer: "server" }, { command: "build" }).resolve?.noExternal).toEqual(["@vite-hub/agent", "@t3tools/provider-runtime"])
    expect(configEnvironment("ssr", { consumer: "server" }, { command: "serve" }).resolve?.noExternal).toEqual(["@vite-hub/agent", "@t3tools/provider-runtime"])
  })

  it("reads the registry that the vite dev Nitro plugin installs when Node loads the package", async () => {
    // The package import `#vitehub/agent/registry` and the `server/registry` export must be one module in Node.
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
      import { getAgentFromRegistry } from "@vite-hub/agent"
      import { installAgentRegistry } from "@vite-hub/agent/server/registry"
      const agent = { description: "installed" }
      installAgentRegistry({ default: { echo: async () => ({ default: agent }) }, metadata: { echo: { name: "echo" } } })
      process.stdout.write(String(await getAgentFromRegistry("echo") === agent))
    `], { cwd: packageRoot })
    expect(stdout).toBe("true")
  })

  it("writes and registers the registry plugin only for the vite dev server", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-native-dev-"))
    roots.push(root)
    for (const command of ["serve", "build"] as const) {
      const plugin = hubAgent()
      const nitro: { plugins?: string[] } = {}
      const userConfig = { root, nitro, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }
      // The hook replaces `config.nitro` in place.
      await (plugin.config as (config: typeof userConfig, env: { command: string, mode: string }) => Promise<unknown>)(userConfig, { command, mode: "development" })
      const resolvedConfig = { root, command, plugins: [], build: { outDir: "dist" }, resolve: { alias: [] }, server: {}, createResolver: () => async () => undefined }
      await (plugin.configResolved as (config: unknown) => Promise<void>)(resolvedConfig)
      const plugins = userConfig.nitro.plugins ?? []
      const registryPlugin = join(root, ".vitehub/agent/registry-dev-plugin.ts")
      if (command === "serve") {
        expect(plugins).toContain(registryPlugin)
        expect(await readFile(registryPlugin, "utf8")).toBe([
          'import { installAgentRegistry as viteHubInstall0 } from "@vite-hub/agent/server/registry"',
          'import * as viteHubModule0 from "./registry.mjs"',
          "",
          "viteHubInstall0(viteHubModule0)",
          "",
          "export default function viteHubNativePackagesPlugin() {}",
          "",
        ].join("\n"))
      }
      else expect(plugins).not.toContain(registryPlugin)
    }
  })

  it("installs the KV package that Vite resolves when the host configures KV", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-native-dev-kv-"))
    roots.push(root)
    // SAFETY: `kvImport` is the internal option that `vitehub()` passes.
    const plugin = hubAgent({ kvImport: "vite-hub/_internal/kv" } as never)
    const resolvedConfig = { root, command: "serve", plugins: [{ name: "@vite-hub/kv/vite" }], build: { outDir: "dist" }, resolve: { alias: [] }, server: {}, createResolver: () => async () => undefined }
    await (plugin.configResolved as (config: unknown) => Promise<void>)(resolvedConfig)
    expect(await readFile(join(root, ".vitehub/agent/registry-dev-plugin.ts"), "utf8")).toContain([
      'import { installAgentKV as viteHubInstall1 } from "@vite-hub/agent/server/registry"',
      'import * as viteHubModule1 from "vite-hub/_internal/kv"',
    ].join("\n"))

    // SAFETY: Chat connectors read only `kv` from the installed module.
    const module = { kv: { get: async () => "installed" } } as never
    installAgentKV(module)
    expect(await importOptionalKV()).toBe(module)
  })
})
