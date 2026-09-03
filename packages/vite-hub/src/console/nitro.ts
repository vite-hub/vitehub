import { join } from "node:path"

export function addConsoleDevframeHandler(nitro: { handlers?: Array<{ handler: string; route: string }> }, consoleRuntimeRoot: string): void {
  const route = "/_vitehub/rpc/**"
  const handler = join(consoleRuntimeRoot, "server/devframe.js")
  const handlers = nitro.handlers ??= []
  const conflict = handlers.find(candidate => candidate.route === route && candidate.handler !== handler)
  if (conflict) throw new Error(`Cannot mount the ViteHub Console handler at "${route}" because that route already uses "${conflict.handler}".`)
  if (!handlers.some(candidate => candidate.route === route && candidate.handler === handler)) {
    handlers.push({ handler, route })
  }
}
