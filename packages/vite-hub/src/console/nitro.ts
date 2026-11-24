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
 * Add the Console route of the app: one lazy `<base>/_vitehub/**` handler. The ViteHub Console and the CLI `POST` signed
 * calls to `/_vitehub/rpc`, and a browser `GET`s it with a one-time ticket that an operation made, such as for
 * impersonation or Content preview. A browser that opens `/_vitehub` or `/_vitehub/<page>` goes to the page of the app
 * with the pill, or, in an app without Comments, to that page of the app in the ViteHub Console. See
 * `server/site-entry.ts`. With `siteAccess`, in an app with Comments, `/_vitehub/site` signs the browser in with a Site
 * access token of the Console. See `server/site.ts`.
 */
export function addConsoleRpcHandler(
  nitro: { handlers?: Array<{ handler: string; route?: string }>; modules?: unknown[]; plugins?: string[] },
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
  const suffix = "/_vitehub/**"
  const retainedHandlers = handlers.filter(candidate => !entries.includes(candidate.handler) || candidate.route === undefined || !candidate.route.endsWith(suffix))
  handlers.splice(0, handlers.length, ...retainedHandlers)

  const route = mountPath(base, suffix)
  // The paths that the one route serves itself. A handler of the app on one of them would answer in place of the Console.
  const routes = [route, ...["/_vitehub", "/_vitehub/rpc", ...options.siteAccess ? ["/_vitehub/site"] : []].map(path => mountPath(base, path))]
  const conflict = retainedHandlers.find(candidate => candidate.route !== undefined && routes.includes(candidate.route))
  if (conflict) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message: `Cannot mount the ViteHub Console handler at "${conflict.route}" because that route already uses "${conflict.handler}".` })
  }
  // The route checks its own access: a signed POST has no app session, and a ticket GET has the ticket as proof. Its
  // modules import the generated Console app module. Loaded on the first request, they stay out of every cold start.
  kit.addHandler({ handler, lazy: true, meta: { ...consoleRouteMeta }, route }, "end")

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
