import { installViteHubPageTools, installViteHubSiteVisitor, registerViteHubPageAccount, registerViteHubPageTool } from "@vite-hub/internal/runtime/page-tools"
import { installRequestStandardContext } from "@vite-hub/runtime/internal/h3"
import { configuredPublicOrigins } from "@vite-hub/runtime/internal/public-url"
import { isRuntimeResponse } from "@vite-hub/runtime/internal/runtime-type"

import { consoleAuthorizedSections, installedConsoleAccessPolicy } from "./access-policy.ts"
import { isConsoleDevelopmentBuild } from "./development.ts"

import type { ViteHubPageAccount, ViteHubSiteVisitor, ViteHubSiteVisitorReader } from "@vite-hub/internal/runtime/page-tools"
import type { ConsoleUser } from "../../auth-types.ts"

export interface ConsolePageToolOptions {
  /** The app base, such as `/portal/`. The page tools use it for the loader tag of Nitro 3 pages. Default: the root. */
  base?: string
  /** The path of the segment script below the app base, such as `/_vitehub/console/assets/page-tool.js?v=2`. */
  script: string
  /**
   * Reads the person of the Site access cookie below the app base. Generated output loads `readConsoleSiteVisitor()` of
   * `server/site.ts`. The page tools, such as Comments, read the same person.
   */
  site: (request: Request, base: string) => Promise<ViteHubSiteVisitor | undefined>
}

const siteSignOutPath = "/_vitehub/site"

function consoleSiteUser(visitor: ViteHubSiteVisitor): ConsoleUser {
  return { id: visitor.id, name: visitor.name, ...(visitor.email ? { email: visitor.email } : {}), ...(visitor.image ? { image: visitor.image } : {}), role: visitor.roles.join(",") }
}

/**
 * Whether a visitor gets the **Console** link in the page tools pill. The link opens the app in the hosted Console,
 * which checks the person and the team itself, so the link gives no access. This only keeps it away from the app's
 * end users.
 * - A development server shows it to every visitor.
 * - With `console.authorize`, it runs with `via: "page"` and the Site access person as `user`. `true`, or
 *   `{ sections }` with at least one section, shows the link.
 * - Without `authorize`, it shows to a Site access person with the `console` role: a member of the Console team.
 */
export async function consolePageToolAllowed(request: Request, options: { site?: ViteHubSiteVisitorReader } = {}): Promise<boolean> {
  if (isConsoleDevelopmentBuild()) return true
  const policy = installedConsoleAccessPolicy()
  if (!policy || policy.mode === "local") return false
  const visitor = await options.site?.(request)
  if (!policy.authorize) return visitor?.roles.includes("console") === true
  const result: unknown = await policy.authorize(visitor ? { request, user: consoleSiteUser(visitor), via: "page" } : { request, via: "page" })
  if (result === true) return true
  return !isRuntimeResponse(result) && (consoleAuthorizedSections(result)?.length ?? 0) > 0
}

export function consolePageAccount(visitor: ViteHubSiteVisitor, signOut: string): ViteHubPageAccount {
  return {
    name: visitor.name,
    ...(visitor.kind === "member" && visitor.email ? { email: visitor.email } : {}),
    ...(visitor.image ? { image: visitor.image } : {}),
    via: "console",
    ...(visitor.kind === "guest" ? { guest: true } : {}),
    signOut,
  }
}

/**
 * Registers the **Console** link in the page tools pill, and installs the page tools, so an app with the Console and no
 * Comments gets them too. It also installs the reader of the Site access cookie, and registers the account of the pill:
 * the Site access person and a sign-out of Site access. Generated Console output calls this with the app base. A build
 * serves the page tools only on the origins of `vitehub({ publicUrl })`, when it is set. A development server serves
 * them on every origin.
 */
export function installConsolePageTool(nitroApp: unknown, options: ConsolePageToolOptions): void {
  const base = options.base ?? "/"
  const site: ViteHubSiteVisitorReader = request => options.site(request, base)
  installViteHubSiteVisitor(site)
  const signOut = `${base.replace(/\/+$/, "")}${siteSignOutPath}`
  registerViteHubPageAccount(nitroApp, async ({ request }) => {
    installRequestStandardContext(request)
    const visitor = await site(request)
    return visitor && consolePageAccount(visitor, signOut)
  })
  registerViteHubPageTool(nitroApp, {
    id: "console",
    label: "Console",
    icon: "i-lucide-square-terminal",
    script: options.script,
    async allowed({ request }) {
      installRequestStandardContext(request)
      return await consolePageToolAllowed(request, { site })
    },
  })
  installViteHubPageTools(nitroApp, { base: options.base, origins: isConsoleDevelopmentBuild() ? [] : configuredPublicOrigins() })
}
