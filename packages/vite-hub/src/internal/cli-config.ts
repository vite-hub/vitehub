import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { ConfigEnv, InlineConfig, ResolvedConfig } from "vite"

const configExtensions = ["js", "mjs", "cjs", "ts", "mts", "cts"]

function hasConfig(rootDir: string, name: string): boolean {
  return configExtensions.some(extension => existsSync(join(rootDir, `${name}.config.${extension}`)))
}

type ResolveViteConfig = (
  inlineConfig: InlineConfig,
  command: ConfigEnv["command"],
  mode: string,
) => Promise<Pick<ResolvedConfig, "plugins" | "root">>

type LoadNuxt = (options: {
  cwd: string
  dev: boolean
  dotenv?: false
  envName?: string
  overrides: { dev?: boolean, devtools: { enabled: false }, vite?: { mode: string }, vitehubCliDiscovery: true }
  ready: true
}) => Promise<{
  close?: () => Promise<void> | void
  options: {
    rootDir?: string
    vite?: InlineConfig
  }
}>

type LoadNuxtConfig = (options: Omit<Parameters<LoadNuxt>[0], "ready">) => Promise<Awaited<ReturnType<LoadNuxt>>["options"]>

async function resolveNuxtKit(rootDir: string): Promise<{ loadNuxt: LoadNuxt, loadNuxtConfig: LoadNuxtConfig }> {
  const require = createRequire(join(rootDir, "package.json"))
  // SAFETY: nuxt/kit owns these public config loaders and require.resolve selects that installed module.
  return await import(pathToFileURL(require.resolve("nuxt/kit")).href) as { loadNuxt: LoadNuxt, loadNuxtConfig: LoadNuxtConfig }
}

async function defaultResolveViteConfig(
  inlineConfig: InlineConfig,
  command: ConfigEnv["command"],
  mode: string,
): Promise<Pick<ResolvedConfig, "plugins" | "root">> {
  const { resolveConfig } = await import("vite")
  return await resolveConfig(inlineConfig, command, mode)
}

export async function loadViteHubCliConfig(
  rootDir: string,
  command: ConfigEnv["command"] = "serve",
  mode?: string,
  dependencies: {
    loadNuxt?: LoadNuxt
    loadNuxtConfig?: LoadNuxtConfig
    resolveViteConfig?: ResolveViteConfig
  } = {},
): Promise<Pick<ResolvedConfig, "plugins" | "root"> & { vitehubConfigResolved: true }> {
  const resolvedMode = mode ?? (command === "build" ? "production" : "development")
  const resolveViteConfig = dependencies.resolveViteConfig ?? defaultResolveViteConfig
  if (!hasConfig(rootDir, "nuxt")) {
    return {
      // SAFETY: vitehubCliDiscovery is an internal marker consumed by ViteHub's plugin before Vite reads the config.
      ...await resolveViteConfig({ root: rootDir, vitehubCliDiscovery: true } as InlineConfig, command, resolvedMode),
      vitehubConfigResolved: true,
    }
  }

  const loadNuxt = dependencies.loadNuxt ?? (await resolveNuxtKit(rootDir)).loadNuxt
  const options: Parameters<LoadNuxt>[0] = {
    cwd: rootDir,
    dev: command === "serve",
    ...(mode ? { envName: mode } : {}),
    overrides: { devtools: { enabled: false }, ...(mode ? { vite: { mode } } : {}), vitehubCliDiscovery: true },
    ready: true,
  }
  if (mode) {
    // Resolve directories without loading the project .env or installing modules first.
    const loadNuxtConfig = dependencies.loadNuxtConfig ?? (await resolveNuxtKit(rootDir)).loadNuxtConfig
    const config = await loadNuxtConfig({ ...options, dotenv: false, overrides: { ...options.overrides, dev: options.dev } })
    const nuxtRoot = config.rootDir || rootDir
    const viteRoot = resolve(nuxtRoot, config.vite?.root || nuxtRoot)
    const envDir = config.vite?.envDir === false ? false : resolve(viteRoot, config.vite?.envDir || ".")
    const { loadEnv } = await import("vite")
    Object.assign(process.env, loadEnv(mode, envDir, ""))
    options.dotenv = false
  }
  const nuxt = await loadNuxt(options)
  try {
    const nuxtRoot = nuxt.options.rootDir || rootDir
    const viteRoot = resolve(nuxtRoot, typeof nuxt.options.vite?.root === "string" ? nuxt.options.vite.root : nuxtRoot)
    return {
      // SAFETY: vitehubCliDiscovery is an internal marker consumed by ViteHub's plugin before Vite reads the config.
      ...await resolveViteConfig({
        ...nuxt.options.vite,
        configFile: false,
        root: viteRoot,
        vitehubCliDiscovery: true,
      } as InlineConfig, command, resolvedMode),
      vitehubConfigResolved: true,
    }
  }
  finally {
    await nuxt.close?.()
  }
}
