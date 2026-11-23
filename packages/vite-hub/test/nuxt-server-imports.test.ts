import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { resolveViteHubServerImports, viteHubServerImports, type ViteHubServerImportFeature } from "../src/nuxt-server-imports.ts"
import { linkFixtureModules } from "./content-preview-fixture.ts"

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

  it("uses Nuxt runtime imports and restores the fallback on utility refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-nuxt-server-imports-"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await linkFixtureModules(root, { nuxt: dirname(createRequire(import.meta.url).resolve("nuxt/package.json")) })
      const files = {
        "package.json": JSON.stringify({ private: true, type: "module" }),
        "nuxt.config.ts": `export default defineNuxtConfig({
          compatibilityDate: "2026-10-01",
          experimental: { nitroAutoImports: true },
          ignore: ["**/ignored.ts"],
          modules: [["vite-hub/nuxt", { host: "node", kv: true, queue: true, env: false }], "./late-module"],
          nitro: { imports: {
            imports: [{ from: "./server/values", name: "sendQueue", type: true, priority: 100 }],
            presets: [{ from: "./server/values", imports: ["useSource"], disabled: true }],
          } },
          telemetry: false,
        })`,
        "late-module.ts": `export default function (_, nuxt) {
          nuxt.hook("nitro:config", config => {
            config.imports.imports.push({ from: "./server/values", name: "readKV", as: "kv", priority: -2 })
          })
        }`,
        "server/values.ts": "export const useSource = () => 'app'\nexport const readKV = () => 'app'\nexport type sendQueue = string\n",
        "server/utils/ignored.ts": "export const useSource = () => 'ignored'\n",
      }
      for (const [file, source] of Object.entries(files)) {
        await mkdir(dirname(join(root, file)), { recursive: true })
        await writeFile(join(root, file), source)
      }
      const { loadNuxt } = await import("nuxt")
      const { writeTypes } = await import("nuxt/kit")
      const nuxt = await loadNuxt({ cwd: root, overrides: { dev: false, _prepare: true } })
      try {
        await writeTypes(nuxt)
        const declarations = () => readFile(join(nuxt.options.buildDir, "types/server-imports.d.ts"), "utf8")
        const fallback = /const useSource: typeof import\(['"]vite-hub\/source['"]\)/
        expect(await declarations()).toMatch(fallback)
        expect(await declarations()).toMatch(/const kv: typeof import\([^\n]*server\/values/)
        expect(await declarations()).toMatch(/const sendQueue: typeof import\(['"]vite-hub\/queue['"]\)/)

        const barrel = join(root, "server/utils/source.ts")
        const path = relative(nuxt.options.srcDir, barrel)
        for (let attempt = 0; attempt < 2; attempt++) {
          await writeFile(barrel, "export * from '../values'\n")
          await nuxt.callHook("builder:watch", "add", path)
          expect(await declarations()).toMatch(/const useSource: typeof import\([^\n]*server\/(utils\/source|values)/)
          await rm(barrel)
          await nuxt.callHook("builder:watch", "unlink", path)
          expect(await declarations()).toMatch(fallback)
        }
        const warnings = warn.mock.calls.map(([message]) => String(message)).filter(message => message.startsWith("[vitehub]") && message.includes("auto-imports"))
        expect(warnings).toHaveLength(2)
        expect(warnings.join("\n")).toContain("already auto-imports `useSource`")
        expect(warnings.join("\n")).toContain("already auto-imports `kv`")
      }
      finally {
        await nuxt.close()
      }
    }
    finally {
      warn.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
