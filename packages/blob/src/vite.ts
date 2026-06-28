import { getViteMode } from "@vite-hub/internal/build/mode"
import { resetComposedProviderOutput, shouldSkipViteProviderBuild, useComposedProviderOutput } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment } from "@vite-hub/internal/build/vite"

import { generateProviderOutputs, prepareProviderOutputs, blobPackageName } from "./internal/vite-build.ts"
import { createBlobCloudflareProvisionStep, createBlobVercelProvisionStep } from "./provision.ts"
import {
  BLOB_VIRTUAL_CONFIG_ID,
  BLOB_VITE_PLUGIN_NAME,
  resolveBlobViteConfig,
} from "./vite-config.ts"

import type { BlobViteRuntimeConfig } from "./vite-config.ts"
import type { BlobModuleOptions } from "./types.ts"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ComposedProviderOutput } from "@vite-hub/internal/build/deployment-output"
import type { Plugin } from "vite"

const RESOLVED_BLOB_VIRTUAL_CONFIG_ID = `\0${BLOB_VIRTUAL_CONFIG_ID}`

export { BLOB_VIRTUAL_CONFIG_ID, BLOB_VITE_PLUGIN_NAME, resolveBlobViteConfig }
export type { BlobViteRuntimeConfig } from "./vite-config.ts"

export interface BlobVitePluginAPI {
  getConfig: () => BlobViteRuntimeConfig
}

interface BlobProvisionContributingPlugin {
  vitehub?: { cli?: () => Promise<ViteHubCliContributor> }
}

export type BlobVitePlugin = Plugin & BlobProvisionContributingPlugin & { api: BlobVitePluginAPI }

const mergeNoExternal = createNoExternalMerger(blobPackageName)

function serializeVirtualConfig(config: BlobViteRuntimeConfig): string {
  return [
    `export const hosting = ${JSON.stringify(config.hosting)};`,
    `export const blob = ${JSON.stringify(config.blob)};`,
    "export default { hosting, blob };",
  ].join("\n")
}

export function hubBlob(options?: BlobModuleOptions): BlobVitePlugin {
  let blob: BlobModuleOptions | undefined = options
  let clientOutDir = "dist"
  let command: "build" | "serve" = "serve"
  let providerArtifacts: Awaited<ReturnType<typeof prepareProviderOutputs>> | undefined
  let providerOutput: ComposedProviderOutput | undefined
  let rootDir = process.cwd()
  let runtimeConfig: BlobViteRuntimeConfig | undefined
  const getConfig = () => runtimeConfig ??= resolveBlobViteConfig(options)

  return {
    name: BLOB_VITE_PLUGIN_NAME,
    api: { getConfig },
    vitehub: {
      cli: async () => {
        return {
          namespaces: [],
          provision: [createBlobCloudflareProvisionStep(() => blob), createBlobVercelProvisionStep(() => blob)],
        }
      },
    },
    config(config, env) {
      command = env.command
      blob = config.blob ?? blob
    },
    configResolved(config) {
      clientOutDir = config.build.outDir
      rootDir = config.root
      blob = config.blob ?? blob
      providerOutput = useComposedProviderOutput(config)
      runtimeConfig = resolveBlobViteConfig(blob)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: {
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
    buildStart() {
      resetComposedProviderOutput(providerOutput)
    },
    async buildEnd() {
      if (shouldSkipViteProviderBuild(command, getViteMode())) {
        return
      }

      providerArtifacts = await prepareProviderOutputs({
        blob,
        providerOutput,
        rootDir,
      })
    },
    async closeBundle() {
      if (shouldSkipViteProviderBuild(command, getViteMode())) {
        return
      }

      await generateProviderOutputs({
        blob,
        clientOutDir,
        artifacts: providerArtifacts,
        providerOutput,
        rootDir,
      })
    },
    load(id) {
      if (id === RESOLVED_BLOB_VIRTUAL_CONFIG_ID) {
        return serializeVirtualConfig(getConfig())
      }
    },
    resolveId(id) {
      if (id === BLOB_VIRTUAL_CONFIG_ID) {
        return RESOLVED_BLOB_VIRTUAL_CONFIG_ID
      }
    },
  }
}

declare module "vite" {
  interface UserConfig {
    blob?: BlobModuleOptions
  }
}
