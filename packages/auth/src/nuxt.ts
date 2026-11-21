import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createEnvImportAliases, hubEnv } from "@vite-hub/env/vite"
import { resolveNuxtServerDirs, resolveViteHubProjectRoot, type NuxtServerDirOptions } from "@vite-hub/internal/build/vite"

import { assertNoCachedPageGuards, type NuxtPageLike } from "./page-guard-cache.ts"
import { AUTH_VITE_PLUGIN_NAME, createAuthNitroConfig, hubAuth, resolveAuthViteConfig, writeNuxtAuthDefinition } from "./vite.ts"

import { authAbilitiesCandidates } from "./discovery.ts"

import type { AuthPageGuardConfig, AuthPages } from "./nuxt-types.ts"
import type { AuthOptions } from "./types.ts"
import type { EnvVitePlugin } from "@vite-hub/env/vite"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

export type { AuthPageMeta, AuthPageMode, AuthPages } from "./nuxt-types.ts"

export interface AuthNuxtModuleOptions {
  auth?: AuthOptions
  env?: false | { projectRoot?: string }
  importsFrom?: string
  nitro?: boolean
}

type NuxtLike = {
  callHook?: (name: "restart") => Promise<void>
  hook?: (name: "nitro:config", handler: (nitroConfig: Record<string, unknown>) => Promise<void>) => void
  options: {
    dev?: boolean
    watch?: string[]
    runtimeConfig?: { public?: Record<string, unknown> }
    plugins?: Array<string | { src: string, order?: number }>
    _layers?: NuxtServerDirOptions["_layers"]
    alias?: Record<string, string>
    app?: {
      baseURL?: string
    }
    experimental?: {
      extraPageMetaExtractionKeys?: string[]
    }
    imports?: {
      imports?: Array<{ from: string, name: string }>
    }
    nitro?: {
      alias?: Record<string, string>
      plugins?: string[]
    }
    rootDir?: string
    routeRules?: Record<string, Record<string, unknown>>
    router?: {
      options?: { sensitive?: boolean }
    }
    serverDir?: string
    srcDir?: string
    ssr?: boolean
    vite?: {
      define?: Record<string, unknown>
      plugins?: unknown[]
      root?: string
    }
  }
}

type NuxtComponent = {
  chunkName: string
  export: string
  filePath: string
  global: boolean
  kebabName: string
  meta: Record<string, unknown>
  mode: "all"
  pascalName: string
  prefetch: boolean
  preload: boolean
  priority: number
  shortPath: string
}

const composables = ["useAbility", "useAuthClient", "useUserSession"]
const nitroRegistered = new WeakSet<object>()
const vueBridgeRegistered = new WeakSet<object>()
const pageMetaRegistered = new WeakSet<object>()
const componentsRegistered = new WeakSet<object>()
const abilitiesWatchRegistered = new WeakSet<object>()
const manifestRegistered = new WeakSet<object>()
const pageCacheCheckRegistered = new WeakSet<object>()

type NitroBuild = {
  hooks: { hook: (name: "build:config", callback: () => Promise<void> | void) => void }
  options: { routeRules: Parameters<typeof assertNoCachedPageGuards>[1] }
}

/** Better Auth's Vue client file, which `createAuthClient()` imports on first use. */
function resolveBetterAuthVueClient(): string | undefined {
  try {
    return realpathSync(fileURLToPath(import.meta.resolve("better-auth/vue")))
  }
  catch {
    return undefined
  }
}

/**
 * Attaches the page guard to the pages of `access.pages` with the `appMiddleware` route rule. Nuxt runs it on the server
 * render and on navigation in the browser. Nuxt merges the rules of all matching patterns and the most specific pattern
 * wins, so each rule sets both modes: `false` and a narrower other mode remove the mode of a wider pattern.
 * `assertAuthPages()` accepts only the patterns that keep this order.
 */
function guardPages(routeRules: NonNullable<NuxtLike["options"]["routeRules"]>, pages: AuthPages): void {
  for (const [path, mode] of Object.entries(pages)) {
    const rule = routeRules[path] ??= {}
    // Keep the middleware that the app attaches to the same pattern.
    rule.appMiddleware = { ...appMiddlewareRecord(rule.appMiddleware), "vitehub-auth-user": mode === "user", "vitehub-auth-guest": mode === "guest" }
  }
}

/** `appMiddleware` as a record. Nuxt reads a name or a list as `{ [name]: true }`. */
function appMiddlewareRecord(value: unknown): object | undefined {
  if (typeof value === "string" || Array.isArray(value)) return Object.fromEntries([value].flat().map(name => [name, true]))
  return typeof value === "object" && value !== null ? value : undefined
}

type PageWithRules = { path: string, rules?: { appMiddleware?: unknown }, children?: PageWithRules[] }

/**
 * Nuxt merges the `defineRouteRules()` of a page over the rule of each rou3 pattern of the page with `defu`. On the
 * pattern of an `access.pages` key, a name or a list then replaces the guard record, and a record merges with it. Other
 * patterns keep the value of the page, because `defu` joins two lists. A page with an optional parameter has several
 * patterns, and a record of the page would replace a name or a list of the app on the others, so they become records.
 * Keys match the rou3 patterns exactly: Nuxt turns the lists into records before it merges keys that differ only in a
 * parameter name, such as `/team/:id` and `/team/:_0`.
 */
function expandPageMiddleware(pages: readonly PageWithRules[], patternsOf: (path: string) => string[], keys: ReadonlySet<string>, routeRules: NonNullable<NuxtLike["options"]["routeRules"]>, prefix = ""): void {
  for (const page of pages) {
    const middleware = page.rules?.appMiddleware
    const patterns = patternsOf(prefix + page.path)
    if (page.rules && (typeof middleware === "string" || Array.isArray(middleware)) && patterns.some(pattern => keys.has(pattern))) {
      page.rules.appMiddleware = appMiddlewareRecord(middleware)
      for (const pattern of patterns) {
        const rule = routeRules[pattern]
        if (typeof rule?.appMiddleware === "string" || Array.isArray(rule?.appMiddleware)) rule.appMiddleware = appMiddlewareRecord(rule.appMiddleware)
      }
    }
    // Nuxt joins a child path to the path of its parent the same way.
    if (page.children) expandPageMiddleware(page.children, patternsOf, keys, routeRules, `${prefix}${page.path}/`)
  }
}

export default function hubAuthNuxt(options: AuthNuxtModuleOptions = {}, nuxt?: NuxtLike): void {
  if (!nuxt) return

  nuxt.options.plugins ??= []
  const vueRuntimePlugin = fileURLToPath(new URL("./runtime/vue-nuxt.js", import.meta.url))
  const ensureVueRuntimePlugin = () => {
    const index = nuxt.options.plugins!.findIndex(plugin => typeof plugin === "string" ? plugin === vueRuntimePlugin : plugin.src === vueRuntimePlugin)
    if (index === 0) return
    const bridge = index < 0 ? { src: vueRuntimePlugin, order: -1 } : nuxt.options.plugins!.splice(index, 1)[0]
    nuxt.options.plugins!.unshift(bridge)
  }
  ensureVueRuntimePlugin()

  nuxt.options.vite ??= {}
  nuxt.options.vite.plugins ??= []
  const vitePlugins = nuxt.options.vite.plugins.flat(Infinity) as Array<{ name?: string }>
  const viteRoot = nuxt.options.vite.root || nuxt.options.rootDir || process.cwd()
  const configuredEnvProjectRoot = resolve(viteRoot, options.env === false ? "." : options.env?.projectRoot || ".")
  const existingEnvPlugin = vitePlugins.find(plugin => plugin?.name === "@vite-hub/env/vite") as EnvVitePlugin | undefined
  const envPlugin = existingEnvPlugin || (options.env === false ? undefined : hubEnv(options.env))
  const envProjectRoot = envPlugin?.api.resolveProjectRoot(viteRoot) || configuredEnvProjectRoot
  if (options.env !== false && options.env?.projectRoot && existingEnvPlugin && envProjectRoot !== configuredEnvProjectRoot) {
    throw authErrorDiagnostics.AUTH_B0001({ message: "`@vite-hub/auth/nuxt` env.projectRoot must match the installed `@vite-hub/env/vite` plugin." })
  }
  if (options.env !== false && !existingEnvPlugin) {
    nuxt.options.vite.plugins.push(envPlugin!)
  }
  // The default Vue Auth client sends requests below Nuxt `app.baseURL`. Nitro server code receives the same value from the Auth Nitro config.
  nuxt.options.vite.define = {
    ...nuxt.options.vite.define,
    __VITEHUB_AUTH_APP_BASE_URL__: JSON.stringify(nuxt.options.app?.baseURL || "/"),
  }
  const authPlugin = vitePlugins.find(plugin => plugin?.name === AUTH_VITE_PLUGIN_NAME) || hubAuth(options.auth)
  if (!vitePlugins.some(plugin => plugin?.name === AUTH_VITE_PLUGIN_NAME)) nuxt.options.vite.plugins.push(authPlugin)

  const resolveAuthOptions = () => options.auth
  const resolveAuthConfig = () => {
    const configRoot = resolve(viteRoot)
    const serverDirs = resolveNuxtServerDirs(nuxt.options)
    const authOptions = resolveAuthOptions()
    return resolveAuthViteConfig(authOptions, configRoot, { serverDirs })
      ?? resolveAuthViteConfig(authOptions, resolveViteHubProjectRoot(configRoot), { serverDirs })
  }

  if (options.nitro !== false && !nitroRegistered.has(nuxt)) {
    nitroRegistered.add(nuxt)
    nuxt.hook?.("nitro:config", async (nitroConfig) => {
      // Nitro can run before Vite's configResolved hook. Resolve discovery
      // directly from the Nuxt/Vite inputs so the virtual definition alias is
      // available during Nitro setup.
      const authConfig = resolveAuthConfig()
      if (authConfig) {
        nitroConfig.alias = {
          ...(nitroConfig.alias as Record<string, string> | undefined),
          "#vitehub/auth/definition": await writeNuxtAuthDefinition(viteRoot, authConfig),
          ...(authConfig.abilities ? { "#vitehub/auth/abilities": authConfig.abilities } : {}),
        }
      }
      Object.assign(nitroConfig, createAuthNitroConfig(authPlugin as ReturnType<typeof hubAuth>, {
        nitro: nitroConfig,
        projectRoot: viteRoot,
        serverDirs: resolveNuxtServerDirs(nuxt.options),
      }))
    })
  }

  if (!vueBridgeRegistered.has(nuxt) && nuxt.hook) {
    vueBridgeRegistered.add(nuxt)
    // Modules may register plugins after this module. Reassert the bridge once
    // module registration is complete, before Nuxt starts running plugins.
    ;(nuxt.hook as unknown as (name: "modules:done", handler: () => Promise<void>) => void)("modules:done", async () => {
      ensureVueRuntimePlugin()
    })
  }

  // The session bridge and page guard share the discovered Auth path and the sign-in pages of `access`.
  const authConfig = resolveAuthOptions() === false ? undefined : resolveAuthConfig()
  const signIn = authConfig?.access.signIn
  nuxt.options.runtimeConfig ??= {}
  nuxt.options.runtimeConfig.public ??= {}
  nuxt.options.runtimeConfig.public.vitehubAuth = resolveAuthOptions() === false ? false : {
    basePath: authConfig?.basePath ?? "/api/auth",
    signInPage: signIn && "provider" in signIn ? null : signIn?.page ?? "/login",
    afterSignIn: authConfig?.access.afterSignIn ?? "/",
  } satisfies AuthPageGuardConfig
  const accessPages = authConfig?.access.pages
  if (accessPages) {
    guardPages(nuxt.options.routeRules ??= {}, accessPages)
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- `NuxtLike` types only the hook that every caller passes; Nuxt calls `pages:resolved` before it merges the rules of the pages, and nuxt.test.ts checks it.
    if (nuxt.hook) (nuxt.hook as unknown as (name: "pages:resolved", handler: (pages: PageWithRules[]) => Promise<void>) => void)("pages:resolved", async (pages) => {
      const { vueRouterToRou3 } = await import("unrouting")
      expandPageMiddleware(pages, path => vueRouterToRou3(path, { collapse: true }).patterns, new Set(Object.keys(accessPages)), nuxt.options.routeRules ??= {})
    })
  }
  if (!pageMetaRegistered.has(nuxt) && nuxt.hook) {
    pageMetaRegistered.add(nuxt)
    ;(nuxt.hook as unknown as (name: "prepare:types", handler: (options: { declarations: string[] }) => void) => void)("prepare:types", ({ declarations }) => {
      declarations.push(`declare module "#app" {\n  interface PageMeta {\n    /** Who may open the page. See https://vitehub.dev/docs/auth/protect-pages. */\n    auth?: import("@vite-hub/auth/nuxt").AuthPageMeta\n  }\n}`)
    })
  }

  if (!componentsRegistered.has(nuxt) && nuxt.hook) {
    componentsRegistered.add(nuxt)
    const filePath = options.importsFrom || "@vite-hub/auth/vue"
    // The same entry that `@nuxt/kit`'s addComponent() writes, without a dependency on `@nuxt/kit`.
    ;(nuxt.hook as unknown as (name: "components:extend", handler: (components: NuxtComponent[]) => void) => void)("components:extend", (components) => {
      for (const name of ["Can", "Cannot"]) {
        // An app component with the same name wins.
        if (components.some(component => component.pascalName === name)) continue
        components.push({
          chunkName: `components/${name.toLowerCase()}`,
          export: name,
          filePath,
          global: false,
          kebabName: name.toLowerCase(),
          meta: {},
          mode: "all",
          pascalName: name,
          prefetch: false,
          preload: false,
          priority: 0,
          shortPath: filePath,
        })
      }
    })
  }

  if (!manifestRegistered.has(nuxt) && nuxt.hook) {
    manifestRegistered.add(nuxt)
    // Nuxt prefetches the dynamic imports of the app entry on every page. The Auth plugin loads the composables only for
    // a guarded page, and the client imports Better Auth on first use, so remove both imports from the hints: a page
    // that does not use Auth downloads neither.
    ;(nuxt.hook as unknown as (name: "build:manifest", handler: (manifest: Record<string, { dynamicImports?: string[] }>) => void) => void)("build:manifest", (manifest) => {
      // Node loads this module from its real path, so the built composables next to it have a real path too.
      const lazy = new Set([resolveBetterAuthVueClient(), fileURLToPath(new URL("./vue.js", import.meta.url))])
      // Vite writes manifest keys relative to its root. Nuxt resolves `vite.root` to `srcDir` unless the app sets it.
      const root = nuxt.options.vite?.root || nuxt.options.srcDir || nuxt.options.rootDir || process.cwd()
      const keys = new Set(Object.keys(manifest).filter(id => lazy.has(resolve(root, id))))
      if (!keys.size) return
      for (const chunk of Object.values(manifest)) chunk.dynamicImports &&= chunk.dynamicImports.filter(id => !keys.has(id))
    })
  }

  if (resolveAuthOptions() !== false && !pageCacheCheckRegistered.has(nuxt) && nuxt.hook) {
    pageCacheCheckRegistered.add(nuxt)
    // Nuxt reads a `definePageMeta()` key into the page at build time only when the key is in this list or
    // `experimental.extractSerializablePageMeta` is on.
    nuxt.options.experimental ??= {}
    const extractionKeys = nuxt.options.experimental.extraPageMetaExtractionKeys ??= []
    if (!extractionKeys.includes("auth")) extractionKeys.push("auth")
    let pages: readonly NuxtPageLike[] = []
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- `NuxtLike` types only the hook that every caller passes; Nuxt calls `pages:resolved` with the handler shape below, and nuxt.test.ts and page-guard-cache.test.ts check it.
    ;(nuxt.hook as unknown as (name: "pages:resolved", handler: (resolved: NuxtPageLike[]) => void) => void)("pages:resolved", (resolved) => {
      pages = resolved
    })
    // Nitro calls `build:config` after every `nitro:build:before` hook and before it bundles the server, so the check
    // reads the final route rules and pages. With `ssr: false`, the server renders no page, so no page guard runs there.
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- `NuxtLike` types only the hook that every caller passes; Nuxt calls `nitro:init` with the handler shape below, and nuxt.test.ts and page-guard-cache.test.ts check it.
    ;(nuxt.hook as unknown as (name: "nitro:init", handler: (nitro: NitroBuild) => void) => void)("nitro:init", (nitro) => {
      nitro.hooks.hook("build:config", () => nuxt.options.ssr === false ? undefined : assertNoCachedPageGuards(pages, nitro.options.routeRules, { sensitive: nuxt.options.router?.options?.sensitive, accessPages: authConfig?.access.pages }))
    })
  }

  nuxt.options.imports ??= {}
  nuxt.options.imports.imports ??= []
  for (const name of composables) {
    if (!nuxt.options.imports.imports.some((entry) => entry.name === name)) {
      nuxt.options.imports.imports.push({
        from: options.importsFrom || "@vite-hub/auth/vue",
        name,
      })
    }
  }

  if (nuxt.options.dev && options.auth !== false && nuxt.hook && !abilitiesWatchRegistered.has(nuxt)) {
    abilitiesWatchRegistered.add(nuxt)
    const files = authAbilitiesCandidates(viteRoot, { serverDirs: resolveNuxtServerDirs(nuxt.options) })
    nuxt.options.watch ??= []
    for (const directory of new Set([...files.app, ...files.layers].map(dirname))) {
      if (!nuxt.options.watch.includes(directory)) nuxt.options.watch.push(directory)
    }
    // Nitro's abilities alias is set during startup, so adding or removing a file needs a restart.
    ;(nuxt.hook as unknown as (name: "builder:watch", handler: (event: string, path: string) => Promise<void>) => void)("builder:watch", async (event, path) => {
      if (event !== "add" && event !== "unlink") return
      const candidates = authAbilitiesCandidates(viteRoot, { serverDirs: resolveNuxtServerDirs(nuxt.options) })
      if ([...candidates.app, ...candidates.layers].includes(resolve(nuxt.options.rootDir || viteRoot, path))) {
        await nuxt.callHook?.("restart")
      }
    })
  }

  if (options.env === false) return

  const envAliases = createEnvImportAliases({ projectRoot: envProjectRoot })
  const runtimePlugin = fileURLToPath(new URL("./runtime/nuxt.js", import.meta.url))

  nuxt.options.alias = { ...envAliases, ...nuxt.options.alias }
  nuxt.options.nitro ??= {}
  nuxt.options.nitro.alias = { ...envAliases, ...nuxt.options.nitro.alias }
  nuxt.options.nitro.plugins ??= []
  if (!nuxt.options.nitro.plugins.includes(runtimePlugin)) {
    nuxt.options.nitro.plugins.push(runtimePlugin)
  }
}
