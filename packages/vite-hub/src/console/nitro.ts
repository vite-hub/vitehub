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
        const conflict = nitro.scannedHandlers.find(candidate => !candidate.middleware && candidate.route !== undefined && routes.includes(withoutTrailingSlashes(candidate.route)))
        if (!conflict) return
        throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message: `Cannot mount the ViteHub Console handler at "${conflict.route}" because the app route "${conflict.handler}" uses that path. Move the app route to another path.` })
      })
    },
  }
}

function withoutTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "")
}

function isConsoleRouteGuard(value: unknown): boolean {
  return value instanceof Object && "name" in value && value.name === consoleRouteGuardName
}

/**
 * Add the Console route of the app: lazy handlers under `<base>/_vitehub`. The ViteHub Console and the CLI `POST` signed
 * calls to `/_vitehub/rpc`. A browser that opens `/_vitehub` or `/_vitehub/<page>` goes to the page of the app with the
 * pill, or, in an app without Comments, to that page of the app in the ViteHub Console. See `server/site-entry.ts`.
 * `/_vitehub/site` takes the tokens of the Console: impersonation and Content preview in every app, and with
 * `siteAccess`, in an app with Comments, Site access. See `server/site.ts`.
 */
export function addConsoleRpcHandler(
  nitro: { handlers?: Array<{ handler: string; route?: string }>; modules?: unknown[]; plugins?: string[]; routes?: Record<string, unknown> },
  consoleRuntimeRoot: string,
  base?: string,
  options: { siteAccess?: boolean } = {},
): void {
  const kit = createNitroServerKit(nitro)
  // SAFETY: The Console adds Nitro handlers with a string handler and an optional route.
  const handlers = kit.config.handlers as NitroHandler[]
  const consoleEntry = join(consoleRuntimeRoot, "server/entry.js")
  const siteAccessEntry = join(consoleRuntimeRoot, "server/entry-site-access.js")
  const entries = [consoleEntry, siteAccessEntry]
  const handler = options.siteAccess ? siteAccessEntry : consoleEntry
  const suffixes = ["/_vitehub/**", "/_vitehub", "/_vitehub/rpc", "/_vitehub/site"]
  const retainedHandlers = handlers.filter(candidate => !entries.includes(candidate.handler) || !suffixes.some(suffix => candidate.route?.endsWith(suffix)))
  handlers.splice(0, handlers.length, ...retainedHandlers)

  const routes = suffixes.map(path => mountPath(base, path))
  const taken = (path: string) => routes.includes(withoutTrailingSlashes(path))
  const conflict = retainedHandlers.find(candidate => candidate.route !== undefined && taken(candidate.route))
  if (conflict) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message: `Cannot mount the ViteHub Console handler at "${conflict.route}" because that route already uses "${conflict.handler}".` })
  }
  const routeConflict = Object.keys(nitro.routes ?? {}).find(taken)
  if (routeConflict) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message: `Cannot mount the ViteHub Console handler at "${routeConflict}" because the Nitro routes option uses that path. Move the app route to another path.` })
  }
  for (const route of routes) kit.addHandler({ handler, lazy: true, meta: { ...consoleRouteMeta }, route }, "end")
  const operationLoader = join(consoleRuntimeRoot, "operation-loader.js")
  nitro.plugins = [...new Set([...nitro.plugins ?? [], operationLoader])]

  // SAFETY: The kit preserves the caller's Nitro handler array while adding the Console routes.
  nitro.handlers = kit.config.handlers as Array<{ handler: string; route?: string }>
  // A second registration, such as a config reload, replaces the guard with the current routes.
  nitro.modules = [...(nitro.modules ?? []).filter(module => !isConsoleRouteGuard(module)), consoleRouteGuard(routes)]
}
