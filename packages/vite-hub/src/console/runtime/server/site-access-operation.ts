import { viteHubPageGrants } from "@vite-hub/internal/runtime/page-tools"
import * as v from "valibot"

import { consoleAccessWrites, readConsoleAccessGrants } from "./access.ts"
import { defineConsoleOperation } from "./operations.ts"
import { consoleRequestError } from "./request.ts"

import type { AnyOperation } from "@vite-hub/internal/operations"
import type { SiteAccessPolicy } from "@vite-hub/internal/site-token"

const siteAccessGet = defineConsoleOperation({
  cli: false,
  description: "Read the Site access of the caller: whether they may change it, and the page tool roles that they get and may give guests.",
  input: v.strictObject({}),
  kind: "read",
  name: "site.access",
  run: (_input, context): SiteAccessPolicy => {
    const roles = viteHubPageGrants()
    const grants = readConsoleAccessGrants(context.access)
    if (grants) {
      const known = new Set(roles.map(role => role.id))
      const unknown = grants.filter(grant => !known.has(grant))
      if (unknown.length) throw consoleRequestError(500, `console.authorize returned grants that no page tool of this app gives: ${unknown.join(", ")}.`)
    }
    return {
      write: consoleAccessWrites(context.access, "site"),
      roles: roles.filter(role => !grants || grants.includes(role.id)).map(({ id, label, description }) => ({ id, label, ...(description ? { description } : {}) })),
    }
  },
  section: "site",
})

/**
 * `site.access`: the Site access of the caller, which the ViteHub Console reads before it signs a Site access token.
 * `write` follows write access to the `site` section, and `roles` are the `grants` of `console.authorize`, or every page
 * tool role of the app. The Console registers it only when the app has the Site access section.
 */
export const siteAccessOperations: readonly AnyOperation[] = [siteAccessGet]
