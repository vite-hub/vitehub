import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createEnvImportAliases, hubEnv } from "@vite-hub/env/vite"
import { resolveNuxtServerDirs, resolveViteHubProjectRoot, type NuxtServerDirOptions } from "@vite-hub/internal/build/vite"

import { AUTH_VITE_PLUGIN_NAME, createAuthNitroConfig, hubAuth, resolveAuthViteConfig } from "./vite.ts"

import type { AuthOptions } from "./types.ts"
import type { EnvVitePlugin } from "@vite-hub/env/vite"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

export type { AuthPageMeta, AuthPageMode, AuthRedirects } from "./nuxt-types.ts"

export interface AuthNuxtModuleOptions {
  auth?: AuthOptions
  env?: false | { projectRoot?: string }
  importsFrom?: string
  nitro?: boolean
}

type NuxtLike = {
  hook?: (name: "nitro:config", handler: (nitroConfig: Record<string, unknown>) => Promise<void>) => void
  options: {
    runtimeConfig?: { public?: Record<string, unknown> }
    plugins?: Array<string | { src: string, order?: number }>
    _layers?: NuxtServerDirOptions["_layers"]
    alias?: Record<string, string>
    app?: {
      baseURL?: string
    }
    imports?: {
      imports?: Array<{ from: string, name: string }>
    }
    nitro?: {
      alias?: Record<string, string>
      plugins?: string[]
    }
    rootDir?: string
    serverDir?: string
    vite?: {
      define?: Record<string, unknown>
      plugins?: unknown[]
      root?: string
    }
  }
}

const composables = ["useAuthClient", "useSession", "useUserSession"]
const nitroRegistered = new WeakSet<object>()
const vueBridgeRegistered = new WeakSet<object>()
const pageMetaRegistered = new WeakSet<object>()

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
      const definitionHandler = resolveAuthConfig()?.definition.handler
      if (definitionHandler) {
        nitroConfig.alias = {
          ...(nitroConfig.alias as Record<string, string> | undefined),
          "#vitehub/auth/definition": definitionHandler,
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

  // The session bridge and page guard share the discovered Auth path and redirects.
  const authOptions = resolveAuthOptions()
  const redirects = authOptions ? authOptions.redirects : undefined
  nuxt.options.runtimeConfig ??= {}
  nuxt.options.runtimeConfig.public ??= {}
  nuxt.options.runtimeConfig.public.vitehubAuth = authOptions === false ? false : {
    basePath: resolveAuthConfig()?.basePath ?? "/api/auth",
    redirects: { login: redirects?.login ?? "/login", guest: redirects?.guest ?? "/" },
  }
  if (!pageMetaRegistered.has(nuxt) && nuxt.hook) {
    pageMetaRegistered.add(nuxt)
    ;(nuxt.hook as unknown as (name: "prepare:types", handler: (options: { declarations: string[] }) => void) => void)("prepare:types", ({ declarations }) => {
      declarations.push(`declare module "#app" {\n  interface PageMeta {\n    /** Who may open the page. See https://vitehub.dev/docs/auth/hosts. */\n    auth?: import("@vite-hub/auth/nuxt").AuthPageMeta\n  }\n}`)
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
