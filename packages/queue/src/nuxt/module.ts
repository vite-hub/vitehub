import { resolve } from "node:path"

import { defineNuxtModule } from "@nuxt/kit"
import { resolveModulePath } from "exsolve"
import type { NitroConfig } from "nitro/types"

import type { QueueModuleOptions } from "../types.ts"

const NITRO_MODULE_ID = "@vitehub/queue/nitro"
type QueueNuxtOptions = Exclude<QueueModuleOptions, false>

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  const fromSource = resolveModulePath(srcRelative, {
    extensions: [".ts", ".mts"],
    from: import.meta.url,
    try: true,
  })
  return fromSource ?? resolveModulePath(packageSubpath, {
    extensions: [".js", ".mjs"],
    from: import.meta.url,
  })
}

function resolveRuntimeEntries(srcRelative: string, packageSubpath: string): string[] {
  const sourceEntry = resolveModulePath(srcRelative, {
    extensions: [".ts", ".mts"],
    from: import.meta.url,
    try: true,
  })
  const packageEntry = resolveModulePath(packageSubpath, {
    extensions: [".js", ".mjs"],
    from: import.meta.url,
    try: true,
  })
  return Array.from(new Set([sourceEntry, packageEntry].filter((entry): entry is string => Boolean(entry))))
}

function installQueueRuntimeAliases(
  nuxtOptions: Record<string, any>,
  queue: QueueModuleOptions | undefined,
) {
  const buildDir = resolve(nuxtOptions.rootDir || process.cwd(), nuxtOptions.buildDir || ".nuxt")
  const queueRegistryId = "#vitehub-queue-registry"
  const queueVercelProviderId = "#vitehub-queue-vercel-provider"
  const registryFile = resolve(buildDir, "vitehub", "queue", "registry.mjs")
  const emptyRegistryEntries = resolveRuntimeEntries("../runtime/empty-registry", "@vitehub/queue/runtime/empty-registry")
  const hostedRuntimeEntry = resolveRuntimeEntry("../runtime/hosted", "@vitehub/queue/runtime/hosted")
  const vercelProviderEntry = resolveRuntimeEntry("../runtime/vercel-provider", "@vitehub/queue/runtime/vercel-provider")
  const vercelProviderStubEntry = resolveRuntimeEntry("../runtime/vercel-provider-stub", "@vitehub/queue/runtime/vercel-provider-stub")
  const vercelProviderEntries = resolveRuntimeEntries("../runtime/vercel-provider", "@vitehub/queue/runtime/vercel-provider")
  const hosting = `${process.env.NITRO_PRESET || ""}`.trim()
  const usesVercelProvider = typeof queue === "object" && queue?.provider === "vercel"
    || hosting.includes("vercel")
  const resolvedVercelProviderEntry = usesVercelProvider ? vercelProviderEntry : vercelProviderStubEntry

  const aliases: Record<string, string> = {
    [queueRegistryId]: registryFile,
    [queueVercelProviderId]: resolvedVercelProviderEntry,
  }

  for (const entry of emptyRegistryEntries) aliases[entry] = registryFile
  for (const entry of vercelProviderEntries) aliases[entry] = resolvedVercelProviderEntry
  if (usesVercelProvider) aliases["@vitehub/queue/runtime/hosted"] = hostedRuntimeEntry

  nuxtOptions.alias ||= {}
  Object.assign(nuxtOptions.alias, aliases)

  nuxtOptions.vite ||= {}
  nuxtOptions.vite.resolve ||= {}
  nuxtOptions.vite.resolve.alias ||= {}
  Object.assign(nuxtOptions.vite.resolve.alias, aliases)

  nuxtOptions.nitro ||= {}
  nuxtOptions.nitro.alias ||= {}
  Object.assign(nuxtOptions.nitro.alias, aliases)
}

function installQueueNitroModule(nitro: NitroConfig, queue: QueueModuleOptions | undefined) {
  nitro.modules ||= []
  if (!nitro.modules.includes(NITRO_MODULE_ID)) nitro.modules.push(NITRO_MODULE_ID)
  if (queue !== undefined) nitro.queue = queue
}

const queueNuxtModule: ReturnType<typeof defineNuxtModule<QueueNuxtOptions>> = defineNuxtModule<QueueNuxtOptions>({
  meta: { configKey: "queue", name: "@vitehub/queue/nuxt" },
  setup(inlineOptions: QueueNuxtOptions, nuxt: { options: Record<string, any>; hook: (...args: any[]) => unknown }) {
    const nuxtOptions = nuxt.options as Record<string, any>
    const topLevel = nuxtOptions.queue as QueueModuleOptions | false | undefined
    if (topLevel === false) return

    const queue = topLevel ?? inlineOptions
    const nitro = nuxtOptions.nitro ||= {}
    installQueueNitroModule(nitro, queue)
    installQueueRuntimeAliases(nuxtOptions, queue)
    ;(nuxt.hook as any)("nitro:config", (config: NitroConfig) => {
      installQueueNitroModule(config, queue)
      config.alias ||= {}
      Object.assign(config.alias, nuxtOptions.nitro?.alias || {})
    })
  },
})

export default queueNuxtModule
