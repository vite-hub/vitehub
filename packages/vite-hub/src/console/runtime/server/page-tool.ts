import { installViteHubPageTools, readViteHubPagePass, registerViteHubPagePassReader, registerViteHubPageTool } from "@vite-hub/internal/runtime/page-tools"
import { installRequestStandardContext } from "@vite-hub/runtime"
import { isRuntimeResponse } from "@vite-hub/runtime/internal/runtime-type"

import { consoleAuthorizedSections, installedConsoleAccessPolicy } from "./access-policy.ts"
import { isConsoleDevelopmentBuild } from "./development.ts"

import type { ConsoleUser } from "../../auth-types.ts"

/** The ViteHub Auth user of a page request, and whether Better Auth's `admin()` plugin counts them as an admin. */
export interface ConsolePageUser {
  user: ConsoleUser
  admin: boolean
}

export interface ConsolePageToolOptions {
  /** The app base, such as `/portal/`. The page tools use it for the loader tag of Nitro 3 pages. Default: the root. */
  base?: string
  /** The path of the segment script below the app base, such as `/_vitehub/console/assets/page-tool.js?v=1`. */
  script: string
  /** Reads the ViteHub Auth user of the request. Generated output sets it when the app has Auth. */
  user?: (request: Request) => Promise<ConsolePageUser | undefined>
}

/**
 * Whether a visitor gets the **Console** link in the page tools pill. The link opens the app in the hosted Console,
 * which checks the person and the team itself, so the link gives no access. This only keeps it away from the app's
 * end users.
 * - A development server shows it to every visitor.
 * - A browser with a member page pass, which the Console gave it, sees it. A guest pass never does.
 * - With `console.authorize`, it runs with `via: "page"` and the app's Auth `user`. `true`, or `{ sections }` with at
 *   least one section, shows the link.
 * - Without `authorize`, it shows to a ViteHub Auth user that Better Auth's `admin()` plugin counts as an admin.
 */
export async function consolePageToolAllowed(request: Request, options: Pick<ConsolePageToolOptions, "user"> = {}): Promise<boolean> {
  if (isConsoleDevelopmentBuild()) return true
  const policy = installedConsoleAccessPolicy()
  if (!policy || policy.mode === "local") return false
  if ((await readViteHubPagePass(request))?.grants.includes("console")) return true
  const person = await options.user?.(request)
  if (!policy.authorize) return person?.admin === true
  const result: unknown = await policy.authorize(person ? { request, user: person.user, via: "page" } : { request, via: "page" })
  if (result === true) return true
  return !isRuntimeResponse(result) && (consoleAuthorizedSections(result)?.length ?? 0) > 0
}

/**
 * Registers the **Console** link in the page tools pill, and installs the page tools, so an app with the Console and no
 * Comments gets them too. Generated Console output calls this with the app base.
 */
export function installConsolePageTool(nitroApp: unknown, options: ConsolePageToolOptions): void {
  // Page passes: browsers that the Console linked. Comments reads them through the same reader. See `site-access.ts`.
  registerViteHubPagePassReader(async (request) => {
    installRequestStandardContext(request)
    return await (await import("./site-access.ts")).readConsolePagePass(request)
  })
  registerViteHubPageTool(nitroApp, {
    id: "console",
    label: "Console",
    icon: "i-lucide-square-terminal",
    script: options.script,
    async allowed({ request }) {
      // In a ViteHub app, the Request of the session route carries the Standard Context that Auth reads.
      installRequestStandardContext(request)
      return await consolePageToolAllowed(request, options)
    },
  })
  installViteHubPageTools(nitroApp, { base: options.base })
}
