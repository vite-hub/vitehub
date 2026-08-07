import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createEnvImportAliases, hubEnv } from "@vite-hub/env/vite"

import { AUTH_VITE_PLUGIN_NAME, createAuthNitroConfig, hubAuth } from "./vite.ts"

import type { AuthModuleOptions } from "./types.ts"
import type { EnvVitePlugin } from "@vite-hub/env/vite"

export interface AuthNuxtModuleOptions {
  auth?: AuthModuleOptions
  env?: false | { projectRoot?: string }
  importsFrom?: string
  nitro?: boolean
}

type NuxtLike = {
  hook?: (name: "nitro:config", handler: (nitroConfig: Record<string, unknown>) => Promise<void>) => void
  options: {
    alias?: Record<string, string>
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
      auth?: AuthModuleOptions
      plugins?: unknown[]
      root?: string
    }
  }
}

const composables = ["useAuthClient", "useSession", "useSignIn", "useSignUp", "useUserSession"]
const nitroRegistered = new WeakSet<object>()

export default function hubAuthNuxt(options: AuthNuxtModuleOptions = {}, nuxt?: NuxtLike): void {
  if (!nuxt) return

  nuxt.options.vite ??= {}
  nuxt.options.vite.plugins ??= []
  const vitePlugins = nuxt.options.vite.plugins.flat(Infinity) as Array<{ name?: string }>
  const viteRoot = nuxt.options.vite.root || nuxt.options.rootDir || process.cwd()
  const configuredEnvProjectRoot = resolve(viteRoot, options.env === false ? "." : options.env?.projectRoot || ".")
  const existingEnvPlugin = vitePlugins.find(plugin => plugin?.name === "@vite-hub/env/vite") as EnvVitePlugin | undefined
  const envProjectRoot = existingEnvPlugin?.api.resolveProjectRoot(viteRoot) || configuredEnvProjectRoot
  if (options.env !== false && options.env?.projectRoot && existingEnvPlugin && envProjectRoot !== configuredEnvProjectRoot) {
    throw new TypeError("`@vite-hub/auth/nuxt` env.projectRoot must match the installed `@vite-hub/env/vite` plugin.")
  }
  if (options.env !== false && !existingEnvPlugin) {
    nuxt.options.vite.plugins.push(hubEnv({ ...options.env, projectRoot: envProjectRoot }))
  }
  const authPlugin = vitePlugins.find(plugin => plugin?.name === AUTH_VITE_PLUGIN_NAME) || hubAuth(options.auth)
  if (!vitePlugins.some(plugin => plugin?.name === AUTH_VITE_PLUGIN_NAME)) nuxt.options.vite.plugins.push(authPlugin)

  if (options.nitro !== false && !nitroRegistered.has(nuxt)) {
    nitroRegistered.add(nuxt)
    nuxt.hook?.("nitro:config", async (nitroConfig) => {
      Object.assign(nitroConfig, createAuthNitroConfig(authPlugin as ReturnType<typeof hubAuth>, {
        nitro: nitroConfig,
        projectRoot: viteRoot,
        serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
        viteAuth: nuxt.options.vite?.auth,
      }))
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
