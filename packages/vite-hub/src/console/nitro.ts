import { join } from "node:path"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

export function addConsoleDevframeHandler(nitro: { handlers?: Array<{ handler: string; route: string }> }, consoleRuntimeRoot: string): void {
  const route = "/_vitehub/rpc/**"
  const handler = join(consoleRuntimeRoot, "server/devframe.js")
  const kit = createNitroServerKit(nitro)
  const handlers = kit.config.handlers as Array<{ handler: string; route: string }>
  const conflict = handlers.find(candidate => candidate.route === route && candidate.handler !== handler)
  if (conflict) throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message: `Cannot mount the ViteHub Console handler at "${route}" because that route already uses "${conflict.handler}".` })
  kit.addHandler({ handler, route })
  nitro.handlers = kit.config.handlers as Array<{ handler: string; route: string }>
}
