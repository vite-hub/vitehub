import { installViteHubPageTools, installViteHubSiteVisitor, registerViteHubPageAccount, registerViteHubPageTool } from "@vite-hub/internal/runtime/page-tools"
import { installRequestStandardContext } from "@vite-hub/runtime/internal/h3"
import { configuredPublicOrigins } from "@vite-hub/runtime/internal/public-url"
import { isRuntimeResponse } from "@vite-hub/runtime/internal/runtime-type"

import { consoleAuthorizedSections, installedConsoleAccessPolicy } from "./access-policy.ts"
import { isConsoleDevelopmentBuild } from "./development.ts"

import type { ViteHubSiteVisitorReader } from "@vite-hub/internal/runtime/page-tools"
import type { ConsoleUser } from "../../auth-types.ts"
import type { ViteHubPageAccount } from "@vite-hub/internal/runtime/page-tools"

/** The person of a page request, and whether they get the Console link without `authorize`. */
export interface ConsolePageUser {
  user: ConsoleUser
  /** An admin of Better Auth's `admin()` plugin, or a person with the `console` role that Site access gives. */
  console: boolean
  /** The path of Better Auth's sign-out route, such as `/api/auth/sign-out`. */
  signOut: string
}

export interface ConsolePageToolOptions {
  /** The app base, such as `/portal/`. The page tools use it for the loader tag of Nitro 3 pages. Default: the root. */
  base?: string
  /** The path of the segment script below the app base, such as `/_vitehub/console/assets/page-tool.js?v=2`. */
  script: string
  /** Reads the ViteHub Auth user of the request. Generated output sets it when the app has Auth. */
  user?: (request: Request) => Promise<ConsolePageUser | undefined>
  /**
   * Reads the Site access cookie of an app without Auth. Generated output sets it when the app has no Auth. The page
   * tools, such as Comments, read the same person, and the Console link uses it when `user` is not set.
   */
  site?: ViteHubSiteVisitorReader
}

/** The Site access person as the user of the Console page tool. A Console member has the `console` role. */
function siteUser(site: ViteHubSiteVisitorReader): (request: Request) => Promise<Omit<ConsolePageUser, "signOut"> | undefined> {
  return async (request) => {
    const visitor = await site(request)
    if (!visitor) return undefined
    const { roles, ...person } = visitor
    return { user: { ...person, role: roles.join(",") }, console: roles.includes("console") }
  }
}

/**
 * Whether a visitor gets the **Console** link in the page tools pill. The link opens the app in the hosted Console,
 * which checks the person and the team itself, so the link gives no access. This only keeps it away from the app's
 * end users.
 * - A development server shows it to every visitor.
 * - With `console.authorize`, it runs with `via: "page"` and the app's Auth `user`. `true`, or `{ sections }` with at
 *   least one section, shows the link.
 * - Without `authorize`, it shows to a ViteHub Auth user that Better Auth's `admin()` plugin counts as an admin, or
 *   that has the `console` role, which Site access gives to Console members. In an app without Auth, Site access
 *   gives that role in its `vitehub_site` cookie.
 */
export async function consolePageToolAllowed(request: Request, options: { user?: (request: Request) => Promise<Pick<ConsolePageUser, "user" | "console"> | undefined> } = {}): Promise<boolean> {
  if (isConsoleDevelopmentBuild()) return true
  const policy = installedConsoleAccessPolicy()
  if (!policy || policy.mode === "local") return false
  const person = await options.user?.(request)
  if (!policy.authorize) return person?.console === true
  const result: unknown = await policy.authorize(person ? { request, user: person.user, via: "page" } : { request, via: "page" })
  if (result === true) return true
  return !isRuntimeResponse(result) && (consoleAuthorizedSections(result)?.length ?? 0) > 0
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * What the account menu of the pill shows for an Auth user. A guest of Site access has a made-up `.invalid` email, so it
 * shows only the name. The `console` role means that the Console signed this browser in.
 */
export function consolePageAccount({ user, signOut }: ConsolePageUser): ViteHubPageAccount | undefined {
  if (!signOut) return undefined
  const email = text(user.email)
  const shownEmail = email && !/\.invalid$/i.test(email) ? email : undefined
  const image = text(user.image)
  const roles = typeof user.role === "string" ? user.role.split(",").map(role => role.trim()) : []
  return {
    name: text(user.name) ?? shownEmail ?? "Signed in",
    ...(shownEmail ? { email: shownEmail } : {}),
    ...(image ? { image } : {}),
    ...(roles.includes("console") ? { via: "console" as const } : {}),
    ...(roles.includes("guest") ? { guest: true as const } : {}),
    signOut,
  }
}

/**
 * Registers the **Console** link in the page tools pill, and installs the page tools, so an app with the Console and no
 * Comments gets them too. With Auth, it also registers the account of the pill: the signed-in user and a sign-out of
 * the app. Generated Console output calls this with the app base. A build serves the page tools only on the origins of
 * `vitehub({ publicUrl })`, when it is set. A development server serves them on every origin.
 */
export function installConsolePageTool(nitroApp: unknown, options: ConsolePageToolOptions): void {
  if (options.site) installViteHubSiteVisitor(options.site)
  // The link check and the account read the same session: one Auth read per request of the session route.
  const people = new WeakMap<Request, Promise<ConsolePageUser | undefined>>()
  const read = options.user
  const user = read && ((request: Request) => {
    const known = people.get(request)
    if (known) return known
    const person = read(request)
    people.set(request, person)
    return person
  })
  if (user) {
    registerViteHubPageAccount(nitroApp, async ({ request }) => {
      installRequestStandardContext(request)
      const person = await user(request)
      return person && consolePageAccount(person)
    })
  }
  registerViteHubPageTool(nitroApp, {
    id: "console",
    label: "Console",
    icon: "i-lucide-square-terminal",
    script: options.script,
    async allowed({ request }) {
      // In a ViteHub app, the Request of the session route carries the Standard Context that Auth reads.
      installRequestStandardContext(request)
      return await consolePageToolAllowed(request, { user: user ?? (options.site ? siteUser(options.site) : undefined) })
    },
  })
  installViteHubPageTools(nitroApp, { base: options.base, origins: isConsoleDevelopmentBuild() ? [] : configuredPublicOrigins() })
}
