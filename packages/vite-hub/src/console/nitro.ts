import { join } from "node:path"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

export function addConsoleDevframeHandler(nitro: { handlers?: Array<{ handler: string; route: string }> }, consoleRuntimeRoot: string): void {
  addConsoleRpcHandler(nitro, consoleRuntimeRoot)
}

function mountBase(base: string | undefined): string {
  if (!base || base === "./") return ""
  let pathname = base
  if (/^https?:\/\//.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname
    }
    catch {
      return ""
    }
  }
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return ""
  return pathname.replace(/\/+$/, "")
}

function mountPath(base: string | undefined, path: string): string {
  return `${mountBase(base)}${path}`
}

type NitroHandler = { handler: string; method?: string | string[]; middleware?: boolean; route: string }

export function addConsoleRpcHandler(
  nitro: { handlers?: Array<{ handler: string; route: string }> },
  consoleRuntimeRoot: string,
  base?: string,
): void {
  const kit = createNitroServerKit(nitro)
  // SAFETY: The Console only adds Nitro handlers with string handler and route fields.
  const handlers = kit.config.handlers as NitroHandler[]
  const registrations = [
    { suffix: "/_vitehub/rpc/**", handler: join(consoleRuntimeRoot, "server/rpc.js") },
    { suffix: "/_vitehub/env/manage", handler: join(consoleRuntimeRoot, "server/env-manage.js") },
    { suffix: "/_vitehub/channels/replay", handler: join(consoleRuntimeRoot, "server/channel-replay.js") },
    { suffix: "/_vitehub/schedules/run", handler: join(consoleRuntimeRoot, "server/schedule-run.js") },
  ]
  const ownedHandlers = new Set(registrations.map(registration => registration.handler))
  const ownedSuffixes = new Set(registrations.map(registration => registration.suffix))
  const retainedHandlers = handlers.filter(candidate => {
    if (!ownedHandlers.has(candidate.handler)) return true
    return !Array.from(ownedSuffixes).some(suffix => candidate.route === suffix || candidate.route.endsWith(suffix))
  })
  handlers.splice(0, handlers.length, ...retainedHandlers)

  for (const registration of registrations) {
    const route = mountPath(base, registration.suffix)
    const conflict = retainedHandlers.find(candidate => candidate.route === route && candidate.handler !== registration.handler)
    if (conflict) {
      const message = registration.suffix === "/_vitehub/rpc/**"
        ? `Cannot mount the ViteHub Console handler at "${route}" because that route already uses "${conflict.handler}".`
        : `Cannot mount the ViteHub ${registration.suffix.includes("env") ? "Env" : registration.suffix.includes("channels") ? "Channel replay" : "Schedule run"} handler at "${route}" because that route is already registered.`
      throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message })
    }
    const handler: NitroHandler = { handler: registration.handler, route }
    if (registration.suffix !== "/_vitehub/rpc/**") handler.method = "post"
    kit.addHandler(handler)
  }

  // SAFETY: The kit preserves the caller's Nitro handler array while adding the Console routes.
  nitro.handlers = kit.config.handlers as Array<{ handler: string; route: string }>
}
