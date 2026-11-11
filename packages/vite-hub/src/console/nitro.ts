import { join } from "node:path"
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

/**
 * Serves the routes next to the Operations endpoint that are not data routes: the ViteHub skill at
 * `/_vitehub/.well-known/skills`, and with `auth: "app"`, the built-in sign-in page at `/_vitehub/sign-in`, which is the
 * login and consent page of MCP OAuth. Nitro adds the application base to these routes.
 */
export function addConsoleAppRoutes(
  nitro: { handlers?: NitroHandler[], publicAssets?: NitroPublicAsset[] },
  consoleRuntimeRoot: string,
  base?: string,
  appSignIn = false,
): void {
  const signIn = join(consoleRuntimeRoot, "server/sign-in.js")
  const skills = join(consoleRuntimeRoot, "public/skills")
  const handlers = (nitro.handlers ??= []).filter(candidate => candidate.handler !== signIn)
  // Run before primary app Auth, which would reject the signed-out visit to its own sign-in page.
  if (appSignIn) handlers.unshift({ handler: signIn, middleware: true, route: mountPath(base, "/_vitehub/sign-in") })
  nitro.handlers = handlers
  nitro.publicAssets = [
    // The ViteHub skill for `npx skills add <app>/_vitehub`. Static files need no Console sign-in.
    { baseURL: mountPath(base, "/_vitehub/.well-known/skills"), dir: skills, fallthrough: false },
    ...(nitro.publicAssets ?? []).filter(asset => asset.dir !== skills),
  ]
}

export function addConsoleRpcHandler(
  nitro: { handlers?: Array<{ handler: string; route?: string }>; plugins?: string[]; virtual?: Record<string, unknown> },
  consoleRuntimeRoot: string,
  base?: string,
  sections: readonly string[] = [],
  oauth = false,
  crossOrigin = false,
): void {
  const kit = createNitroServerKit(nitro)
  const preflight = join(consoleRuntimeRoot, "server/console-preflight.js")
  // SAFETY: The Console adds Nitro handlers with a string handler and an optional route.
  const handlers = kit.config.handlers as NitroHandler[]
  const registrations: Array<{ absolute?: true, handler: string, method?: "get" | "post", middleware?: true, suffix: string }> = [
    { suffix: "/_vitehub/rpc/**", handler: join(consoleRuntimeRoot, "server/rpc.js") },
    { suffix: "/_vitehub/auth/manage", handler: join(consoleRuntimeRoot, "server/auth-manage.js"), method: "post" },
    { suffix: "/_vitehub/env/manage", handler: join(consoleRuntimeRoot, "server/env-manage.js"), method: "post" },
    { suffix: "/_vitehub/schedules/run", handler: join(consoleRuntimeRoot, "server/schedule-run.js"), method: "post" },
    // The MCP endpoint answers every method itself. Its OAuth metadata lives at the origin root, where clients look.
    { suffix: "/_vitehub/mcp", handler: join(consoleRuntimeRoot, "server/mcp.js") },
    // Nitro runs this route-less middleware for every request.
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
  }
  // SAFETY: The kit preserves the caller's Nitro plugin registrations.
  const plugins = kit.config.plugins as string[]
  const retainedPlugins = plugins.filter(plugin => plugin !== preflight)
  plugins.splice(0, plugins.length, ...retainedPlugins)
  // CORS preflights carry no credentials, so the plugin answers them before every app middleware and app Auth. Only
  // `console.origins` with `auth: "token"` accepts cross-origin calls.
  if (crossOrigin) kit.addPlugin(preflight, "start")
  if (oauth && delegatedPaths.length) {
    nitro.virtual = {
      ...nitro.virtual,
      [configuredMcpDiscovery]: `import { createConsoleMcpDiscoveryHandler } from ${JSON.stringify(join(consoleRuntimeRoot, "server/mcp-discovery.js"))}\nexport default createConsoleMcpDiscoveryHandler(${JSON.stringify(delegatedPaths)})\n`,
    }
    const discovery = registrations.find(registration => registration.middleware)
    if (discovery) discovery.handler = configuredMcpDiscovery
  }

  for (const registration of registrations) {
    // Only the Env section installs the Server Env that this route manages.
    if (registration.suffix === "/_vitehub/env/manage" && !sections.includes("env")) continue
    // Other Console access modes leave the application's origin-wide OAuth discovery routes alone.
    if (registration.absolute && !oauth) continue
    if (registration.suffix === "/_vitehub/auth/manage" && !sections.includes("auth")) continue;
    // Only the Schedules section installs the manual Schedules that this route runs.
    if (registration.suffix === "/_vitehub/schedules/run" && !sections.includes("schedules")) continue;
    const route = registration.absolute ? registration.suffix : mountPath(base, registration.suffix)
    const conflict = !registration.middleware && retainedHandlers.find(candidate => candidate.route === route && candidate.handler !== registration.handler)
    // Discovery middleware serves Console-owned URLs first and delegates the rest to the app.
    if (conflict && registration.absolute) continue
    if (conflict) {
      const message =
        registration.suffix === "/_vitehub/rpc/**"
          ? `Cannot mount the ViteHub Console handler at "${route}" because that route already uses "${conflict.handler}".`
          : `Cannot mount the ViteHub ${registration.suffix.includes("auth") ? "Auth" : registration.suffix.includes("env") ? "Env" : registration.suffix.includes("mcp") ? "MCP" : "Schedule run"} handler at "${route}" because that route is already registered.`;
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
