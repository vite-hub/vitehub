import type { Nuxt } from "nuxt/schema"

/** Options of the `vite-hub/nuxt` module that the assistant depends on. */
interface ViteHubModuleOptions {
  agent?: unknown
  connections?: unknown
}

/**
 * Nitro presets that can start Codex. The ChatGPT plan gateway and the Codex Driver need a local Node.js process;
 * Cloudflare Workers, Deno, and other runtimes cannot start it.
 */
const nodePresetPattern = /^node(?:[-_]|$)/

/** The module name: a string entry, or the `getMeta()` name of an imported module function. */
async function moduleName(module: unknown): Promise<unknown> {
  if (typeof module !== "function") return module
  const getMeta: unknown = Reflect.get(module, "getMeta")
  if (typeof getMeta !== "function") return
  const meta: unknown = await Reflect.apply(getMeta, module, [])
  return meta && typeof meta === "object" ? Reflect.get(meta, "name") : undefined
}

/** Inline and `vitehub` key options of `vite-hub/nuxt`, or `undefined` when the module is not installed. */
async function viteHubModuleOptions(nuxt: Nuxt): Promise<ViteHubModuleOptions | undefined> {
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
 * component, is registered with the other docs components and renders only when this option is on.
 */
export function setupDocsAssistant(nuxt: Nuxt, config: { assistant: { agent: string } | false }): void {
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
    // `vite-hub/nuxt` sets the Nitro preset from its own `preset` option. A development server always runs on Node.
    // Nuxt types `nitro` only when Nitro's types load.
    const nitro: unknown = Reflect.get(nuxt.options, "nitro")
    const preset: unknown = nitro && typeof nitro === "object" ? Reflect.get(nitro, "preset") : undefined
    if (!nuxt.options.dev && typeof preset === "string" && !nodePresetPattern.test(preset)) {
      throw new DocsAssistantSetupError(
        `docs.assistant runs Codex on the "${assistant.agent}" Agent, and Codex needs a Node.js host. The Nitro preset is "${preset}".`,
        `Build for a Node.js host (vitehub: { preset: "node" }), or turn the assistant off for this build, for example docs: { assistant: process.env.NITRO_PRESET !== "${preset}" }.`,
      )
    }
  })
}
