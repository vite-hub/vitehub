import { join } from "node:path"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

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

export function mountPath(base: string | undefined, path: string): string {
  return `${mountBase(base)}${path}`
}

type NitroHandler = { handler: string; method?: string | string[]; middleware?: boolean; route: string }
type NitroPublicAsset = { baseURL?: string, dir: string, fallthrough?: boolean, maxAge?: number }

/**
 * Serves the standalone Console: its HTML page at `/_vitehub/**`, its hashed script, style, and font assets at
 * `/_vitehub/assets`, and the ViteHub skill at `/_vitehub/.well-known/skills`. The page loads its own Vue app, Nuxt UI
 * theme, and styles, so a host app that renders around it, such as Nuxt, cannot change how the Console looks. Nitro
 * adds the application base to these routes.
 */
export function addConsolePageHandlers(
  nitro: { handlers?: NitroHandler[], publicAssets?: NitroPublicAsset[] },
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
  for (const suffix of ["/_vitehub", "/_vitehub/**"]) handlers.push({ handler: page, route: mountPath(base, suffix) })
  nitro.handlers = handlers
  nitro.publicAssets = [
    // Every Console asset name contains a content hash.
    { baseURL: mountPath(base, "/_vitehub/assets"), dir: assets, fallthrough: false, maxAge: 60 * 60 * 24 * 365 },
    // The ViteHub skill for `npx skills add <app>/_vitehub`. Static files need no Console sign-in.
    { baseURL: mountPath(base, "/_vitehub/.well-known/skills"), dir: skills, fallthrough: false },
    ...(nitro.publicAssets ?? []).filter(asset => asset.dir !== assets && asset.dir !== skills),
  ]
}

export function addConsoleRpcHandler(
  nitro: { handlers?: Array<{ handler: string; route: string }> },
  consoleRuntimeRoot: string,
  base?: string,
  sections: readonly string[] = [],
): void {
  const kit = createNitroServerKit(nitro)
  // SAFETY: The Console only adds Nitro handlers with string handler and route fields.
  const handlers = kit.config.handlers as NitroHandler[]
  const registrations = [
    { suffix: "/_vitehub/rpc/**", handler: join(consoleRuntimeRoot, "server/rpc.js") },
    { suffix: "/_vitehub/auth/manage", handler: join(consoleRuntimeRoot, "server/auth-manage.js") },
    { suffix: "/_vitehub/env/manage", handler: join(consoleRuntimeRoot, "server/env-manage.js") },
    { suffix: "/_vitehub/channels/replay", handler: join(consoleRuntimeRoot, "server/channel-replay.js") },
    { suffix: "/_vitehub/schedules/run", handler: join(consoleRuntimeRoot, "server/schedule-run.js") },
    // ViteHub MCP: the tools of the sections that the Console user may use, such as Comments.
    { suffix: "/_vitehub/mcp", handler: join(consoleRuntimeRoot, "server/mcp.js") },
  ]
  const ownedHandlers = new Set(registrations.map(registration => registration.handler))
  const ownedSuffixes = new Set(registrations.map(registration => registration.suffix))
  const retainedHandlers = handlers.filter(candidate => {
    if (!ownedHandlers.has(candidate.handler)) return true
    return !Array.from(ownedSuffixes).some(suffix => candidate.route === suffix || candidate.route.endsWith(suffix))
  })
  handlers.splice(0, handlers.length, ...retainedHandlers)

  for (const registration of registrations) {
    if (registration.suffix === "/_vitehub/auth/manage" && !sections.includes("auth")) continue;
    const route = mountPath(base, registration.suffix)
    const conflict = retainedHandlers.find(candidate => candidate.route === route && candidate.handler !== registration.handler)
    if (conflict) {
      const message =
        registration.suffix === "/_vitehub/rpc/**"
          ? `Cannot mount the ViteHub Console handler at "${route}" because that route already uses "${conflict.handler}".`
          : `Cannot mount the ViteHub ${registration.suffix.includes("auth") ? "Auth" : registration.suffix.includes("env") ? "Env" : registration.suffix.includes("channels") ? "Channel replay" : registration.suffix.includes("mcp") ? "MCP" : "Schedule run"} handler at "${route}" because that route is already registered.`;
      throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message })
    }
    const handler: NitroHandler = { handler: registration.handler, route }
    if (registration.suffix !== "/_vitehub/rpc/**" && registration.suffix !== "/_vitehub/mcp") handler.method = "post"
    kit.addHandler(handler)
  }

  // SAFETY: The kit preserves the caller's Nitro handler array while adding the Console routes.
  nitro.handlers = kit.config.handlers as Array<{ handler: string; route: string }>
}
