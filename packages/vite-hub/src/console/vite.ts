import type { Plugin } from "vite"

const frameworkAgentSpecifier = "vite-hub/agent"

function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, "/").split("?", 1)[0]!
}

export function consoleInvocationRootPlugin(projectRoot: string): Plugin {
  const frameworkAgentEntries = new Set<string>()

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
      return `globalThis[Symbol.for("vitehub.console.invocations.root")] = ${JSON.stringify(projectRoot)}\n${code}`
    },
  }
}
