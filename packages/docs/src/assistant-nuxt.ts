import type {} from "nuxt/schema"

import { docsErrorDiagnostics } from "./error-diagnostics.ts"
import { viteHubModuleOptions } from "./module-options.ts"

import type { ModuleOptionsNuxt } from "./module-options.ts"

/** Only the host fields used here: Nuxt and @nuxt/kit can load different compatible schema versions. */
interface DocsAssistantNuxt extends ModuleOptionsNuxt {
  hook: (name: "modules:done", callback: () => Promise<void>) => unknown
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
      throw docsErrorDiagnostics.DOCS_ASSISTANT_AGENTS_MISSING({ agent: assistant.agent })
    }
  })
}
