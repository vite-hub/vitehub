import { join } from "node:path"
import { addViteHubPageToolRoutes, viteHubPageToolsBase } from "@vite-hub/internal/build/page-tools"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { viteHubBasePath } from "@vite-hub/internal/runtime/page-tools-shared"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

export function mountPath(base: string | undefined, path: string): string {
  return `${viteHubBasePath(base)}${path}`
}

type NitroHandler = { handler: string; lazy?: boolean; method?: string | string[]; middleware?: boolean; route?: string }
// Nitro 3 resolves handler paths against rootDir unless they start with `#`, so a `virtual:` id would become a missing file.
const configuredMcpDiscovery = "#vitehub/console-mcp-discovery"
type NitroPublicAsset = { baseURL?: string, dir: string, fallthrough?: boolean, maxAge?: number }
type NitroPrerenderConfig = { baseURL?: string, prerender?: { ignore?: Array<string | RegExp | ((path: string) => boolean)> } }

/** Keep linked Console pages, which need a signed-in request, out of Nitro's prerender crawler. */
export function ignoreConsolePrerender(nitro: NitroPrerenderConfig, base?: string): void {
  const prerender = nitro.prerender ??= {}
  const { mount } = viteHubPageToolsBase({ base, nitro })
  // Nitro can match crawled links with its base intact or removed. Keep both forms excluded.
  for (const prefix of [base, mount]) {
    const consolePath = mountPath(prefix, "/_vitehub")
    if (!prerender.ignore?.includes(consolePath)) prerender.ignore = [...prerender.ignore ?? [], consolePath]
  }
}

/**
 * Serves the standalone Console: its HTML page at `/_vitehub/**`, its hashed script, style, and font assets at
 * `/_vitehub/assets`, and the ViteHub skill at `/_vitehub/.well-known/skills`. The page loads its own Vue app, Nuxt UI
 * theme, and styles, so a host app that renders around it, such as Nuxt, cannot change how the Console looks. Nitro
 * adds the application base to these routes.
 */
export function addConsolePageHandlers(
  nitro: NitroPrerenderConfig & { handlers?: NitroHandler[], publicAssets?: NitroPublicAsset[] },
  consoleRuntimeRoot: string,
  base?: string,
  signInPage?: string,
): void {
  const page = join(consoleRuntimeRoot, "server/page.get.js")
  const signIn = join(consoleRuntimeRoot, "server/sign-in.js")
  const assets = join(consoleRuntimeRoot, "public/console")
  const skills = join(consoleRuntimeRoot, "public/skills")
  const handlers = (nitro.handlers ??= []).filter(candidate => candidate.handler !== page && candidate.handler !== signIn)
  if (signInPage) {
    // Run before primary app Auth can reject an HTML page visit, including after Nitro config replay.
    for (const suffix of ["/_vitehub", "/_vitehub/**"]) {
      handlers.unshift({ handler: signIn, middleware: true, route: mountPath(base, suffix) })
    }
  }
  for (const suffix of ["/_vitehub", "/_vitehub/**"]) handlers.push({ handler: page, lazy: true, route: mountPath(base, suffix) })
  nitro.handlers = handlers
  ignoreConsolePrerender(nitro, base)
  nitro.publicAssets = [
    // Every Console asset name contains a content hash.
    { baseURL: mountPath(base, "/_vitehub/assets"), dir: assets, fallthrough: false, maxAge: 60 * 60 * 24 * 365 },
    // The ViteHub skill for `npx skills add <app>/_vitehub`. Static files need no Console sign-in.
    { baseURL: mountPath(base, "/_vitehub/.well-known/skills"), dir: skills, fallthrough: false },
    ...(nitro.publicAssets ?? []).filter(asset => asset.dir !== assets && asset.dir !== skills),
  ]
  addConsolePageToolRoutes(nitro, consoleRuntimeRoot, viteHubBasePath(base))
}

/**
 * Serves the page tools session `GET <mount>/_vitehub/page/session` and the loader at `<mount>/_vitehub/page/assets`, so
 * the `console` page tool works in an app without Comments. When Comments added them first, they stay as they are.
 * `mount` is the route prefix from `viteHubPageToolsBase()`, or the Nuxt `app.baseURL` without its trailing slash,
 * like the other Console routes.
 */
export function addConsolePageToolRoutes(
  nitro: { handlers?: Array<{ handler: string; route?: string }>, publicAssets?: NitroPublicAsset[] },
  consoleRuntimeRoot: string,
  mount = "",
): void {
  const kit = createNitroServerKit(nitro)
  addViteHubPageToolRoutes(kit, { handler: join(consoleRuntimeRoot, "server/page-session.js"), loader: join(consoleRuntimeRoot, "page"), mount })
  // SAFETY: The kit keeps the caller's Nitro handler and public asset entries, and the page tools add entries of the same shape.
  nitro.handlers = kit.config.handlers as Array<{ handler: string; route?: string }>
  // SAFETY: As above.
  nitro.publicAssets = kit.config.publicAssets as NitroPublicAsset[]
}

export function addConsoleRpcHandler(
  nitro: { handlers?: Array<{ handler: string; route?: string }>; plugins?: string[]; virtual?: Record<string, unknown> },
  consoleRuntimeRoot: string,
  base?: string,
  sections: readonly string[] = [],
  oauth = false,
): void {
  const kit = createNitroServerKit(nitro)
  // Nitro 2 resolves plugin names against srcDir, so this virtual plugin needs an absolute filename.
  const nitro2McpDiscovery = join(consoleRuntimeRoot, "server/mcp-discovery-nitro2.js")
  // SAFETY: The Console adds Nitro handlers with a string handler and an optional route.
  const handlers = kit.config.handlers as NitroHandler[]
  const registrations: Array<{ absolute?: true, handler: string, method?: "get" | "post", middleware?: true, suffix: string }> = [
    { suffix: "/_vitehub/rpc/**", handler: join(consoleRuntimeRoot, "server/rpc.js") },
    { suffix: "/_vitehub/auth/manage", handler: join(consoleRuntimeRoot, "server/auth-manage.js"), method: "post" },
    { suffix: "/_vitehub/env/manage", handler: join(consoleRuntimeRoot, "server/env-manage.js"), method: "post" },
    { suffix: "/_vitehub/channels/replay", handler: join(consoleRuntimeRoot, "server/channel-replay.js"), method: "post" },
    { suffix: "/_vitehub/schedules/run", handler: join(consoleRuntimeRoot, "server/schedule-run.js"), method: "post" },
    // The MCP endpoint answers every method itself. Its OAuth metadata lives at the origin root, where clients look.
    { suffix: "/_vitehub/mcp", handler: join(consoleRuntimeRoot, "server/mcp.js") },
    // Nitro 2 reads middleware routes as prefixes, so `/**` matches no request. Its non-root app base is handled by
    // the request hook below; Nitro 3 runs this route-less middleware for every request.
    { absolute: true, suffix: "/**", handler: join(consoleRuntimeRoot, "server/mcp-discovery.js"), middleware: true },
    { absolute: true, suffix: "/.well-known/oauth-protected-resource", handler: join(consoleRuntimeRoot, "server/mcp-metadata.js"), method: "get" },
    { absolute: true, suffix: "/.well-known/oauth-protected-resource/**", handler: join(consoleRuntimeRoot, "server/mcp-metadata.js"), method: "get" },
    // Better Auth serves its authorization server metadata below its own base path. MCP clients ask at the origin root.
    { absolute: true, suffix: "/.well-known/oauth-authorization-server", handler: join(consoleRuntimeRoot, "server/mcp-authorization-server.js"), method: "get" },
    { absolute: true, suffix: "/.well-known/oauth-authorization-server/**", handler: join(consoleRuntimeRoot, "server/mcp-authorization-server.js"), method: "get" },
  ]
  const ownedHandlers = new Set(registrations.map(registration => registration.handler))
  ownedHandlers.add(configuredMcpDiscovery)
  const ownedSuffixes = new Set(registrations.map(registration => registration.suffix))
  const retainedHandlers = handlers.filter(candidate => {
    if (!ownedHandlers.has(candidate.handler)) return true
    const route = candidate.route
    if (route === undefined) return false
    return !Array.from(ownedSuffixes).some(suffix => route === suffix || route.endsWith(suffix))
  })
  handlers.splice(0, handlers.length, ...retainedHandlers)

  const delegatedPaths = registrations.filter(registration => registration.absolute && !registration.middleware && !registration.suffix.endsWith("/**"))
    .filter(registration => retainedHandlers.some(candidate => candidate.route === registration.suffix && !candidate.middleware
      && (!candidate.method || [candidate.method].flat().some(method => method.toLowerCase() === "get"))))
    .map(registration => registration.suffix)
  if (nitro.virtual) {
    delete nitro.virtual[configuredMcpDiscovery]
    delete nitro.virtual[nitro2McpDiscovery]
  }
  // SAFETY: The kit preserves the caller's Nitro plugin registrations.
  const plugins = kit.config.plugins as string[]
  const retainedPlugins = plugins.filter(plugin => plugin !== nitro2McpDiscovery)
  plugins.splice(0, plugins.length, ...retainedPlugins)
  if (oauth) {
    // Nitro 2 mounts even route-less middleware below app.baseURL. Its request hook runs at the origin root,
    // before app middleware, and H3 1's respondWith() completes the response without entering the mounted stack.
    nitro.virtual = {
      ...nitro.virtual,
      [nitro2McpDiscovery]: [
        `import { createConsoleMcpDiscoveryHandler } from ${JSON.stringify(join(consoleRuntimeRoot, "server/mcp-discovery.js"))}`,
        `const discovery = createConsoleMcpDiscoveryHandler(${JSON.stringify(delegatedPaths)})`,
        `export default function consoleMcpDiscoveryNitro2(nitroApp) {`,
        `  if (!nitroApp.h3App) return`,
        `  nitroApp.hooks.hook("request", async (event) => {`,
        `    if (event.handled) return`,
        `    const response = await discovery(event)`,
        `    if (response) await event.respondWith(response)`,
        `  })`,
        `}`,
        "",
      ].join("\n"),
    }
    kit.addPlugin(nitro2McpDiscovery, "start")
  }
  if (oauth && delegatedPaths.length) {
    nitro.virtual = {
      ...nitro.virtual,
      [configuredMcpDiscovery]: `import { createConsoleMcpDiscoveryHandler } from ${JSON.stringify(join(consoleRuntimeRoot, "server/mcp-discovery.js"))}\nexport default createConsoleMcpDiscoveryHandler(${JSON.stringify(delegatedPaths)})\n`,
    }
    const discovery = registrations.find(registration => registration.middleware)
    if (discovery) discovery.handler = configuredMcpDiscovery
  }

  for (const registration of registrations) {
    // Other Console access modes leave the application's origin-wide OAuth discovery routes alone.
    if (registration.absolute && !oauth) continue
    if (registration.suffix === "/_vitehub/auth/manage" && !sections.includes("auth")) continue;
    if (registration.suffix === "/_vitehub/channels/replay" && !sections.includes("agents")) continue;
    const route = registration.absolute ? registration.suffix : mountPath(base, registration.suffix)
    const conflict = !registration.middleware && retainedHandlers.find(candidate => candidate.route === route && candidate.handler !== registration.handler)
    // Discovery middleware serves Console-owned URLs first and delegates the rest to the app.
    if (conflict && registration.absolute) continue
    if (conflict) {
      const message =
        registration.suffix === "/_vitehub/rpc/**"
          ? `Cannot mount the ViteHub Console handler at "${route}" because that route already uses "${conflict.handler}".`
          : `Cannot mount the ViteHub ${registration.suffix.includes("auth") ? "Auth" : registration.suffix.includes("env") ? "Env" : registration.suffix.includes("channels") ? "Channel replay" : registration.suffix.includes("mcp") ? "MCP" : "Schedule run"} handler at "${route}" because that route is already registered.`;
      throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message })
    }
    const handler: NitroHandler = registration.middleware ? { handler: registration.handler, middleware: true } : { handler: registration.handler, route }
    if (registration.method) handler.method = registration.method
    // The Console's routes import Agents, Workspaces, Sources, and Comark. Loaded on their first request, they stay out
    // of every cold start of the app around them.
    if (!registration.middleware) handler.lazy = true
    kit.addHandler(handler, registration.middleware ? "start" : "end")
  }

  // SAFETY: The kit preserves the caller's Nitro handler array while adding the Console routes.
  nitro.handlers = kit.config.handlers as Array<{ handler: string; route?: string }>
  // Preserve an outer kit's plugin array so subsequent registrations use the same list.
  if (nitro.plugins) nitro.plugins.splice(0, nitro.plugins.length, ...plugins)
  else nitro.plugins = plugins
}
