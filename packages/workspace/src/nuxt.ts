import { createWorkspaceNitroConfig, hubWorkspace } from "./vite.ts"

import type { WorkspaceModuleOptions } from "./core/types.ts"

export interface WorkspaceNuxtModuleOptions extends WorkspaceModuleOptions {}

type NuxtLike = {
  hook?: (name: "nitro:config", handler: (nitroConfig: Record<string, unknown>) => void | Promise<void>) => void
  options: {
    alias?: Record<string, string>
    dev?: boolean
    imports?: {
      imports?: Array<{ from: string, name: string }>
    }
    rootDir?: string
    srcDir?: string
    vite?: {
      plugins?: unknown[]
      workspace?: false | WorkspaceModuleOptions
    }
  }
}

function isWorkspaceVitePlugin(value: unknown) {
  return Boolean(value && typeof value === "object" && (value as { name?: unknown }).name === "@vite-hub/workspace/vite")
}

function resolveWorkspaceOptions(options: WorkspaceNuxtModuleOptions, viteOptions?: false | WorkspaceModuleOptions) {
  if (viteOptions !== undefined) return viteOptions
  return Object.keys(options).length > 0 ? options : undefined
}

export default function viteHubWorkspaceNuxtModule(options: WorkspaceNuxtModuleOptions = {}, nuxt?: NuxtLike): void {
  if (!nuxt) return

  nuxt.options.imports ??= {}
  nuxt.options.imports.imports ??= []
  for (const name of ["useWorkspaceCollection", "useWorkspaceCollectionItem"]) {
    if (!nuxt.options.imports.imports.some(entry => entry.name === name)) {
      nuxt.options.imports.imports.push({ from: "@vite-hub/workspace/collections/client", name })
    }
  }

  nuxt.options.vite ??= {}
  const workspaceOptions = resolveWorkspaceOptions(options, nuxt.options.vite.workspace)
  const plugins = Array.isArray(nuxt.options.vite.plugins) ? nuxt.options.vite.plugins : []
  if (!plugins.some(isWorkspaceVitePlugin)) {
    plugins.push(hubWorkspace(workspaceOptions === false ? undefined : workspaceOptions))
  }
  nuxt.options.vite.plugins = plugins

  nuxt.hook?.("nitro:config", async (nitroConfig) => {
    const rootDir = nuxt.options.rootDir || process.cwd()
    const nitro = await createWorkspaceNitroConfig({
      aliases: nuxt.options.alias,
      command: nuxt.options.dev ? "serve" : "build",
      nitro: nitroConfig,
      viteRoot: nuxt.options.srcDir || rootDir,
      workspace: workspaceOptions,
    })
    if (nitro) Object.assign(nitroConfig, nitro)
  })
}
