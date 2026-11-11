import { join } from "node:path"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { viteHubBasePath } from "@vite-hub/internal/runtime/page-tools-shared"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

export function mountPath(base: string | undefined, path: string): string {
  return `${viteHubBasePath(base)}${path}`
}

type NitroHandler = { handler: string; lazy?: boolean; meta?: Record<string, unknown>; method?: string | string[]; middleware?: boolean; route?: string }

/**
 * The route `meta` of the Console handler. App Auth access routes leave a request that Nitro routes to it to the
 * Console's own check (`authAccessHandlerMeta` of `@vite-hub/auth/runtime/server`). The exception follows the dispatch,
 * so an app route file on the same path keeps the app Auth access routes.
 */
export const consoleRouteMeta = { vitehubAuthAccess: "handler" } as const
type NitroPublicAsset = { baseURL?: string, dir: string, fallthrough?: boolean, maxAge?: number }

/**
 * Serves the ViteHub skill at `/_vitehub/.well-known/skills` for `npx skills add <app>/_vitehub`. The files are static and
 * public, and match the installed `vite-hub` version. Nitro adds the application base to the path.
 */
export function addConsoleAppRoutes(
  nitro: { publicAssets?: NitroPublicAsset[] },
  consoleRuntimeRoot: string,
  base?: string,
): void {
  const skills = join(consoleRuntimeRoot, "public/skills")
  nitro.publicAssets = [
    { baseURL: mountPath(base, "/_vitehub/.well-known/skills"), dir: skills, fallthrough: false },
    ...(nitro.publicAssets ?? []).filter(asset => asset.dir !== skills),
  ]
}

const consoleRouteGuardName = "vite-hub/console-route-guard"

interface ConsoleRouteGuardNitro {
  hooks: { hook: (name: "build:before", callback: () => void) => unknown }
  scannedHandlers: ReadonlyArray<{ handler: string, middleware?: boolean, route?: string }>
}

/**
 * A Nitro module that refuses an app route file, such as `server/routes/_vitehub/rpc.post.ts`, on a Console route.
 * Nitro picks a handler of one method before a handler of every method, so that file would answer instead of the
 * Console, and app Auth access rules leave the Console POST route to the Console's own check. Nitro scans the route
 * files after the config hooks, so the check runs before the build.
 */
function consoleRouteGuard(routes: readonly string[]): { name: string, setup: (nitro: ConsoleRouteGuardNitro) => void } {
  return {
    name: consoleRouteGuardName,
    setup(nitro) {
      nitro.hooks.hook("build:before", () => {
        const conflict = nitro.scannedHandlers.find(candidate => !candidate.middleware && candidate.route !== undefined && routes.includes(candidate.route))
        if (!conflict) return
        throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message: `Cannot mount the ViteHub Console handler at "${conflict.route}" because the app route "${conflict.handler}" uses that path. Move the app route to another path.` })
      })
    },
  }
}

function isConsoleRouteGuard(value: unknown): boolean {
  return value instanceof Object && "name" in value && value.name === consoleRouteGuardName
}

/**
 * Add the one Console route of the app, `/_vitehub/rpc`. The ViteHub Console and the CLI `POST` signed calls to it, and
 * a browser `GET`s it with a one-time ticket that an operation made, such as for impersonation or Content preview.
 */
export function addConsoleRpcHandler(
  nitro: { handlers?: Array<{ handler: string; route?: string }>; modules?: unknown[]; plugins?: string[] },
  consoleRuntimeRoot: string,
  base?: string,
): void {
  const kit = createNitroServerKit(nitro)
  // SAFETY: The Console adds Nitro handlers with a string handler and an optional route.
  const handlers = kit.config.handlers as NitroHandler[]
  const registrations: Array<{ handler: string, suffix: string }> = [
    // One birpc call per POST, or one ticket per GET. The route answers other requests with 405 and leaves the paths
    // below it to the app.
    { suffix: "/_vitehub/rpc", handler: join(consoleRuntimeRoot, "server/rpc.js") },
  ]
  const ownedHandlers = new Set(registrations.map(registration => registration.handler))
  const ownedSuffixes = registrations.map(registration => registration.suffix)
  const retainedHandlers = handlers.filter((candidate) => {
    if (!ownedHandlers.has(candidate.handler)) return true
    const route = candidate.route
    return route !== undefined && !ownedSuffixes.some(suffix => route === suffix || route.endsWith(suffix))
  })
  handlers.splice(0, handlers.length, ...retainedHandlers)

  const routes: string[] = []
  for (const registration of registrations) {
    const route = mountPath(base, registration.suffix)
    routes.push(route)
    const conflict = retainedHandlers.find(candidate => candidate.route === route && candidate.handler !== registration.handler)
    if (conflict) {
      throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message: `Cannot mount the ViteHub Console handler at "${route}" because that route already uses "${conflict.handler}".` })
    }
    const handler: NitroHandler = { handler: registration.handler, route }
    // The RPC route checks its own access: a signed POST has no app session, and a ticket GET has the ticket as proof.
    handler.meta = { ...consoleRouteMeta }
    // The Console's routes import Agents, Workspaces, Sources, and Comark. Loaded on their first request, they stay out
    // of every cold start of the app around them.
    handler.lazy = true
    kit.addHandler(handler, "end")
  }

  // SAFETY: The kit preserves the caller's Nitro handler array while adding the Console routes.
  nitro.handlers = kit.config.handlers as Array<{ handler: string; route?: string }>
  // A second registration, such as a config reload, replaces the guard with the current routes.
  nitro.modules = [...(nitro.modules ?? []).filter(module => !isConsoleRouteGuard(module)), consoleRouteGuard(routes)]
  // SAFETY: The kit preserves the caller's Nitro plugin registrations.
  const plugins = kit.config.plugins as string[]
  // Preserve an outer kit's plugin array so subsequent registrations use the same list.
  if (nitro.plugins) nitro.plugins.splice(0, nitro.plugins.length, ...plugins)
  else nitro.plugins = plugins
}
