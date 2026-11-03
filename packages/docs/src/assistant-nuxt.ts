import type {} from "nuxt/schema"

/** Only the host fields used here: Nuxt and @nuxt/kit can load different compatible schema versions. */
interface DocsAssistantNuxt {
  options: { modules: readonly unknown[] }
  hook: (name: "modules:done", callback: () => Promise<void>) => unknown
}

/** Options of the `vite-hub/nuxt` module that the assistant depends on. */
interface ViteHubModuleOptions {
  agent?: unknown
  connections?: unknown
}

/** The module name: a string entry, or the `getMeta()` name of an imported module function. */
async function moduleName(module: unknown): Promise<unknown> {
  if (typeof module !== "function") return module
  const getMeta: unknown = Reflect.get(module, "getMeta")
  if (typeof getMeta !== "function") return
  const meta: unknown = await Reflect.apply(getMeta, module, [])
  return meta && typeof meta === "object" ? Reflect.get(meta, "name") : undefined
}

/** Inline and `vitehub` key options of `vite-hub/nuxt`, or `undefined` when the module is not installed. */
async function viteHubModuleOptions(nuxt: DocsAssistantNuxt): Promise<ViteHubModuleOptions | undefined> {
  let installed = false
  let inline: ViteHubModuleOptions = {}
  for (const entry of nuxt.options.modules) {
    const [module, options] = Array.isArray(entry) ? entry : [entry, undefined]
    if (await moduleName(module) !== "vite-hub/nuxt") continue
    installed = true
    if (options && typeof options === "object") inline = { ...inline, ...options }
  }
  // `vitehub` is the module's config key. Its type exists only when the module's types load.
  const configured: unknown = Reflect.get(nuxt.options, "vitehub")
  if (!installed && !configured) return
  return { ...(configured && typeof configured === "object" ? configured : {}), ...inline }
}

/** The error that the build shows when the assistant cannot run. */
export class DocsAssistantSetupError extends Error {
  constructor(why: string, fix: string) {
    super(`[@vite-hub/docs] ${why} ${fix}`)
    this.name = "DocsAssistantSetupError"
  }
}

/**
 * Checks what the docs assistant needs, when `docs.assistant` is on. The docs module calls it from its setup.
 *
 * The assistant's Agent and its ChatGPT Connection are application files (`server/agents/<agent>.ts` and
 * `server/connections/chatgpt.ts`), because Agents and Connections are discovered from files. `DocsAssistant`, the panel
 * component, is registered only when this option is on.
 *
 * Any Nitro preset works. `docsAssistant` runs Codex on Node.js and a model-backed Driver in a Worker build. An Agent
 * that sets a provider Driver itself fails a Worker build with `AGENT_B0019` from `@vite-hub/agent`.
 */
export function setupDocsAssistant(nuxt: DocsAssistantNuxt, config: { assistant: { agent: string } | false }): void {
  const assistant = config.assistant
  if (!assistant) return
  nuxt.hook("modules:done", async () => {
    const vitehub = await viteHubModuleOptions(nuxt)
    if (!vitehub?.agent) {
      throw new DocsAssistantSetupError(
        `docs.assistant needs ViteHub Agents to answer from the "${assistant.agent}" Agent.`,
        `Add "vite-hub/nuxt" to modules and set vitehub: { agent: true, connections: true } in nuxt.config.ts, or set docs.assistant to false.`,
      )
    }
  })
}
