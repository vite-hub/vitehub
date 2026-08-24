import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import type { Plugin } from "vite"

const frameworkAgentSpecifier = "vite-hub/agent"
const consoleRuntimeRoot = fileURLToPath(new URL("./runtime", import.meta.url))
const consolePublicRoot = join(consoleRuntimeRoot, "public/console")
const generatedConsolePlugin = ".vitehub/nitro/console/plugin.mjs"

type ConsoleNitroConfig = {
  handlers?: Array<{ handler: string, route: string }>
  plugins?: string[]
  publicAssets?: Array<{ baseURL?: string, dir: string, fallthrough?: boolean }>
  [key: string]: unknown
}

type ConsoleAgentEntry = { handler: string, name: string }

function renderConsoleNitroPlugin(projectRoot: string, agents: readonly ConsoleAgentEntry[]): string {
  return [
    `import { installConsoleAgentDefinitions, installConsoleInvocations } from "vite-hub/console/server"`,
    ...agents.map((agent, index) => `import * as vitehubConsoleAgent${index} from ${JSON.stringify(agent.handler)}`),
    `const vitehubConsoleInvocations = installConsoleInvocations(${JSON.stringify(projectRoot)})`,
    `installConsoleAgentDefinitions([${agents.map((agent, index) => `{ definition: vitehubConsoleAgent${index}, fallbackName: ${JSON.stringify(agent.name)} }`).join(", ")}], vitehubConsoleInvocations)`,
    "export default function viteHubConsolePlugin() {}",
    "",
  ].join("\n")
}

async function writeConsoleNitroPlugin(
  file: string,
  projectRoot: string,
  agents: readonly ConsoleAgentEntry[],
): Promise<void> {
  const contents = renderConsoleNitroPlugin(projectRoot, agents)
  if (await readFile(file, "utf8").catch(() => undefined) === contents) return
  await mkdir(resolve(file, ".."), { recursive: true })
  await writeFile(file, contents, "utf8")
}

export function discoverConsoleAgentNames(
  root: string,
  serverDirs = [join(root, "server")],
): string[] {
  return discoverAgentDefinitionEntries(root, serverDirs).map(agent => agent.name)
}

function generatedRegistration(value: string, path: string): boolean {
  return value === path || value.replaceAll("\\", "/").endsWith(`/${path}`)
}

export function consoleVitePlugin(): Plugin {
  let generatedPlugin: string | undefined
  let projectRoot: string | undefined
  return {
    name: "vite-hub/console",
    async config(config) {
      const root = resolve(config.root || process.cwd())
      projectRoot = resolveViteHubProjectRoot(root)
      generatedPlugin = resolve(root, generatedConsolePlugin)
      await writeConsoleNitroPlugin(generatedPlugin, projectRoot, discoverAgentDefinitionEntries(root))

      // SAFETY: Nitro extends Vite's user config with this documented top-level configuration object.
      const viteConfig = config as typeof config & { nitro?: ConsoleNitroConfig }
      const nitro: ConsoleNitroConfig = viteConfig.nitro
        ? { ...viteConfig.nitro }
        : {}
      const handlers = Array.isArray(nitro.handlers)
        ? nitro.handlers.filter(handler => ![
            join(consoleRuntimeRoot, "server/invocation.get.js"),
            join(consoleRuntimeRoot, "server/invocations.get.js"),
            join(consoleRuntimeRoot, "server/agents.get.js"),
            join(consoleRuntimeRoot, "server/page.get.js"),
          ].includes(handler?.handler))
        : []
      handlers.push(
        { handler: join(consoleRuntimeRoot, "server/agents.get.js"), route: "/api/_vitehub/console/agents" },
        { handler: join(consoleRuntimeRoot, "server/invocations.get.js"), route: "/api/_vitehub/console/invocations" },
        { handler: join(consoleRuntimeRoot, "server/invocation.get.js"), route: "/api/_vitehub/console/invocations/:id" },
        { handler: join(consoleRuntimeRoot, "server/page.get.js"), route: "/_vitehub" },
        { handler: join(consoleRuntimeRoot, "server/page.get.js"), route: "/_vitehub/**" },
      )
      const plugins = Array.isArray(nitro.plugins)
        ? nitro.plugins.filter(candidate => !generatedRegistration(candidate, generatedConsolePlugin))
        : []
      plugins.push(generatedPlugin)
      const publicAssets = Array.isArray(nitro.publicAssets)
        ? nitro.publicAssets.filter(asset => asset?.baseURL !== "/_vitehub/assets")
        : []
      publicAssets.push({ baseURL: "/_vitehub/assets", dir: consolePublicRoot, fallthrough: false })

      viteConfig.nitro = { ...nitro, handlers, plugins, publicAssets }
    },
    async configResolved(config) {
      projectRoot ||= resolveViteHubProjectRoot(config.root)
      generatedPlugin ||= resolve(config.root, generatedConsolePlugin)
      const serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      await writeConsoleNitroPlugin(
        generatedPlugin,
        projectRoot,
        discoverAgentDefinitionEntries(config.root, serverDirs),
      )
    },
  }
}

function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, "/").split("?", 1)[0]!
}

export function consoleInvocationRootPlugin(configuredProjectRoot?: string): Plugin {
  const frameworkAgentEntries = new Set<string>()
  let projectRoot = configuredProjectRoot

  function rememberFrameworkAgent(id: string): void {
    frameworkAgentEntries.add(normalizeModuleId(id))
  }

  return {
    name: "vite-hub/console-invocation-root",
    applyToEnvironment: environment => environment.config.consumer === "server",
    perEnvironmentStartEndDuringDev: true,
    configEnvironment(_name, config) {
      if (config.consumer !== "server") return
      return { resolve: { noExternal: ["vite-hub"] } }
    },
    configResolved(config) {
      projectRoot ||= resolveViteHubProjectRoot(config.root)
    },
    async buildStart() {
      const resolved = await this.resolve(frameworkAgentSpecifier, undefined, { skipSelf: true })
      if (!resolved) this.error(`[vitehub] Could not resolve ${JSON.stringify(frameworkAgentSpecifier)} for the Agent invocation console.`)
      rememberFrameworkAgent(resolved.id)
    },
    async resolveId(source, importer, options) {
      if (source !== frameworkAgentSpecifier) return
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved) this.error(`[vitehub] Could not resolve ${JSON.stringify(frameworkAgentSpecifier)} for the Agent invocation console.`)
      rememberFrameworkAgent(resolved.id)
      return { ...resolved, external: false }
    },
    transform(code, id) {
      if (!frameworkAgentEntries.has(normalizeModuleId(id))) return
      if (!projectRoot) this.error("[vitehub] Could not resolve the project root for the Agent invocation console.")
      return `globalThis[Symbol.for("vitehub.console.invocations.root")] = ${JSON.stringify(projectRoot)}\n${code}`
    },
  }
}
