import { describe, expect, it } from "vitest"

import { resolveViteHubServerImports, viteHubServerImports, type ViteHubServerImportFeature } from "../src/nuxt-server-imports.ts"

// SAFETY: `Object.keys` widens the keys of the const table to string.
const features = Object.keys(viteHubServerImports) as ViteHubServerImportFeature[]
const names = Object.values(viteHubServerImports).flatMap(sources => Object.values(sources).flat())

// With `experimental.nitroAutoImports`, Nuxt 5 auto-imports these in server code. Without it, Nuxt reports them as
// missing imports. Copied from @nuxt/nitro-server 5 `src/imports.ts`, plus Nuxt's own `imports.imports` entries.
const nuxtServerNames = [
  "clearSession", "createError", "defineEventHandler", "deleteCookie", "deriveSecret", "getCookie", "getQuery",
  "getRequestHeader", "getRequestHeaders", "getRequestHost", "getRequestIP", "getRequestProtocol", "getRequestURL",
  "getRouteRules", "getRouterParam", "getRouterParams", "getSession", "getValidatedQuery", "handleCors", "isNuxtError",
  "matchRouteRules", "parseCookies", "readBody", "readValidatedBody", "sendRedirect", "serverFetch", "setCookie",
  "setResponseStatus", "updateSession", "useRuntimeConfig", "useServerHooks", "useSession",
  "useNitroApp", "defineRouteMeta", "defineNitroErrorHandler", "defineNitroPlugin", "nitroPlugin", "defineCachedFunction",
  "cachedFunction", "defineCachedHandler", "defineCachedEventHandler", "cachedEventHandler", "useKV", "useStorage",
  "defineTask", "runTask", "$fetch", "defineAppConfig", "useAppConfig",
]

describe("ViteHub server auto-imports", () => {
  it("does not reuse a name that Nuxt 5, Nitro, or H3 auto-imports", async () => {
    // With `experimental.nitroAutoImports`, Nuxt 5 also auto-imports every lowercase `nitro/h3` export.
    const h3Names = Object.keys(await import("nitro/h3")).filter(name => !/^[A-Z]/.test(name))
    const reserved = new Set([...nuxtServerNames, ...h3Names])

    expect(names.filter(name => reserved.has(name))).toEqual([])
  })

  it("imports each name from one place", () => {
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([])
  })

  it("auto-imports the I18n request and translations helpers", () => {
    expect(resolveViteHubServerImports({ i18n: true })).toEqual([
      { from: "vite-hub/i18n/server", name: "getRequestI18n", priority: -1 },
      { from: "vite-hub/i18n/server", name: "useTranslations", priority: -1 },
    ])
  })

  it.each(features)("returns only the %s helpers when only that feature is on", (feature) => {
    const expected = Object.entries(viteHubServerImports[feature]).flatMap(([from, list]) => list.map((name: string) => ({ from, name, priority: -1 })))

    expect(resolveViteHubServerImports({ [feature]: true })).toEqual(expected)
    expect(resolveViteHubServerImports({ [feature]: false })).toEqual([])
  })

  it("keeps Definition helpers out when ViteHub also loads their files outside Nitro", () => {
    for (const name of ["defineAgent", "defineAuth", "defineComments", "defineDatabase", "defineSchedule", "defineWorkflow", "defineWorkspace"]) expect(names).not.toContain(name)
  })
})
