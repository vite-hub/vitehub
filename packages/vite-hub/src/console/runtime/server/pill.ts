import { registerViteHubPageAccount, registerViteHubPageTool, installViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"
import { configuredConsoleOrigin } from "@vite-hub/runtime/internal/console"
import { installRequestStandardContext } from "@vite-hub/runtime/internal/h3"

import type { ViteHubPageAccount, ViteHubSiteVisitor, ViteHubSiteVisitorReader } from "@vite-hub/internal/runtime/page-tools"

/** What the Comments pill passes to each segment that it loads. */
export interface ConsolePillOptions {
  /** The app base, such as `/portal/`. Default: the root. */
  base?: string
  /** Whether a development server runs the app. It shows the Console segment to every visitor. */
  development?: boolean
  /** The `vite-hub` version of the app. The Console serves the segment script of this version. */
  version: string
}

const siteSignOutPath = "/_vitehub/site"

/** What the account menu of the pill shows for a Site access person. `signOut` is the app's `/_vitehub/site`. */
export function consolePageAccount(visitor: ViteHubSiteVisitor, signOut: string): ViteHubPageAccount {
  return {
    name: visitor.name,
    ...(visitor.kind === "member" && visitor.email ? { email: visitor.email } : {}),
    ...(visitor.image ? { image: visitor.image } : {}),
    via: "console",
    signOut,
  }
}

/**
 * The URL of the Console segment script on the ViteHub Console, such as
 * `https://console.vitehub.dev/page/0.4.0/page-tool.js?base=/portal`, or the same path on the Console of
 * `vitehub({ console: { url } })`. The script reads the app base from `base`.
 */
export function consolePillScript(version: string, base = "/"): string {
  return `${configuredConsoleOrigin()}/page/${encodeURIComponent(version)}/page-tool.js?${new URLSearchParams({ base: base.replace(/\/+$/, "") })}`
}

/**
 * Adds the **Console** segment to the Comments pill. The ViteHub Console serves its script, so the page needs a
 * Content Security Policy that allows scripts from the Console origin. The segment shows to a Site access person with
 * the `console` role, a member of the Console team, and on a development server to every visitor. The Console checks
 * the person and the team itself, so the segment gives no access. It also installs the reader of the Site access
 * cookie, which Comments reads, and the account of the pill: the Site access person and a sign-out of Site access.
 */
export function installConsolePill(nitroApp: unknown, options: ConsolePillOptions): void {
  const base = options.base || "/"
  const development = options.development === true
  const site: ViteHubSiteVisitorReader = async request => (await import("./site-visitor.ts")).readConsoleSiteVisitor(request, base, development)
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
    script: consolePillScript(options.version, base),
    async allowed({ request }) {
      if (development) return true
      installRequestStandardContext(request)
      return (await site(request))?.roles.includes("console") === true
    },
  })
}
