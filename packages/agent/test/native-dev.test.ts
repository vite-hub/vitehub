import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"
import { transformWithOxc } from "vite"

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
          'const appRoot = typeof __VITEHUB_AGENT_APP_ROOT__ === "undefined" ? undefined : __VITEHUB_AGENT_APP_ROOT__',
          'if (appRoot !== undefined) Reflect.set(globalThis, ["__VITEHUB_", "AGENT_APP_ROOT", "__"].join(""), appRoot)',
          'import { installAgentRegistry as viteHubInstall0 } from "@vite-hub/agent/server/registry"',
          'import * as viteHubModule0 from "./registry.mjs"',
          'import { installAgentKV as viteHubInstall1 } from "@vite-hub/agent/server/registry"',
          'import { installAgentServerEnv as viteHubInstall2 } from "@vite-hub/agent/server/registry"',
          "",
          "viteHubInstall0(viteHubModule0)",
          "viteHubInstall1(undefined)",
          "viteHubInstall2(undefined)",
          "",
          "export default function viteHubNativePackagesPlugin() {}",
          "",
        ].join("\n"))
      }
      else expect(plugins).not.toContain(registryPlugin)
    }
  })

  it("installs the native registry before existing plugin modules evaluate, on startup and reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-native-order-"))
    roots.push(root)
    const consumer = join(root, "consumer.mjs")
    const plugin = hubAgent()
    const config = { root, nitro: { plugins: [consumer] }, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }
    await (plugin.config as (config: unknown, env: unknown) => Promise<unknown>)(config, { command: "serve", mode: "development" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ root, command: "serve", plugins: [], build: { outDir: "dist" }, resolve: { alias: [] }, server: {}, createResolver: () => async () => undefined })
    const installer = join(root, ".vitehub/agent/registry-dev-plugin.ts")
    const source = (await readFile(installer, "utf8")).replaceAll("@vite-hub/agent/server/registry", import.meta.resolve("@vite-hub/agent/server/registry"))
    await writeFile(consumer, `import { getAgentFromRegistry } from ${JSON.stringify(import.meta.resolve("@vite-hub/agent"))}\nprocess.stdout.write((await getAgentFromRegistry("echo")).description)\nexport default () => {}\n`)
    for (const revision of ["first", "second"]) {
      await writeFile(join(root, ".vitehub/agent/registry.mjs"), `export default { echo: async () => ({ default: { description: ${JSON.stringify(revision)} } }) }\nexport const metadata = { echo: { name: "echo" } }\n`)
      await writeFile(installer.replace(".ts", `-${revision}.mjs`), source.replace("./registry.mjs", `./registry-${revision}.mjs`))
      await writeFile(join(root, `.vitehub/agent/registry-${revision}.mjs`), await readFile(join(root, ".vitehub/agent/registry.mjs")))
      await writeFile(join(root, `${revision}.mjs`), config.nitro.plugins.map(path => `import ${JSON.stringify(pathToFileURL(path === installer ? installer.replace(".ts", `-${revision}.mjs`) : path).href + `?${revision}`)}`).join("\n"))
    }
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(join(root, "first.mjs")).href)}); await import(${JSON.stringify(pathToFileURL(join(root, "second.mjs")).href)})`])
    expect(stdout).toBe("firstsecond")
  })

  it.each(["vite", "nitro"])("preserves standalone provider discovery from the app root with %s defines", async (transform) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-native-root-"))
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-agent-native-cwd-"))
    roots.push(root, cwd)
    const binary = join(root, "node_modules/@openai/codex/bin/codex.js")
    await mkdir(join(root, "node_modules/@openai/codex/bin"), { recursive: true })
    await writeFile(join(root, "package.json"), "{}")
    await writeFile(join(root, "node_modules/@openai/codex/package.json"), JSON.stringify({ name: "@openai/codex" }))
    await writeFile(binary, "")

    const plugin = hubAgent()
    const config = { root, nitro: {}, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }
    const result = await (plugin.config as (config: unknown, env: unknown) => Promise<{ define: Record<string, string> }>)(config, { command: "serve", mode: "development" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ root, command: "serve", plugins: [], build: { outDir: "dist" }, resolve: { alias: [] }, server: {}, createResolver: () => async () => undefined })
    const installer = join(root, ".vitehub/agent/registry-dev-plugin.ts")
    let source = (await readFile(installer, "utf8")).replaceAll("@vite-hub/agent/server/registry", import.meta.resolve("@vite-hub/agent/server/registry"))
    if (transform === "vite") source = (await transformWithOxc(source, installer, { define: result.define })).code
    else {
      // Nitro also replaces define names inside strings, so the global's name must be constructed at runtime.
      const nitro = config.nitro as { replace: Record<string, string> }
      source = source.replaceAll(/\b__VITEHUB_AGENT_APP_ROOT__\b/g, nitro.replace.__VITEHUB_AGENT_APP_ROOT__!)
    }
    await writeFile(join(root, ".vitehub/agent/registry.mjs"), "export default {}; export const metadata = {}\n")
    const nativeInstaller = installer.replace(".ts", ".mjs")
    await writeFile(nativeInstaller, source)
    const resolver = new URL("../src/internal/provider-runtime-packages.ts", import.meta.url).href
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
      import { resolveInstalledProviderExecutable } from ${JSON.stringify(resolver)}
      const before = resolveInstalledProviderExecutable("codex", { platform: "linux" })
      await import(${JSON.stringify(pathToFileURL(nativeInstaller).href)})
      process.stdout.write(JSON.stringify({
        before: before === ${JSON.stringify(binary)},
        after: resolveInstalledProviderExecutable("codex", { platform: "linux" }),
        appRoot: globalThis.__VITEHUB_AGENT_APP_ROOT__,
      }))
    `], { cwd })
    expect(JSON.parse(stdout)).toEqual({ before: false, after: binary, appRoot: root })
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
    installAgentKV(undefined)
  })

  it("hands the generated Server Env module to the native Agent and clears it when Env is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-native-dev-env-"))
    roots.push(root)
    for (const plugins of [[{ name: "@vite-hub/env/vite" }], []]) {
      const plugin = hubAgent()
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ root, command: "serve", plugins, build: { outDir: "dist" }, resolve: { alias: [] }, server: {}, createResolver: () => async () => undefined })
      const source = await readFile(join(root, ".vitehub/agent/registry-dev-plugin.ts"), "utf8")
      if (plugins.length) {
        expect(source).toContain('import * as viteHubModule2 from "#vitehub/env/server"')
        expect(source).toContain("viteHubInstall2(viteHubModule2)")
      }
      else {
        expect(source).not.toContain('from "#vitehub/env/server"')
        expect(source).toContain("viteHubInstall2(undefined)")
      }
    }
  })
})
