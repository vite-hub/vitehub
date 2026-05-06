import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "pathe"

import { defaultCloudflareCompatibilityDate } from "@vitehub/internal/build/cloudflare"
import { writeProviderDeploymentOutputs } from "@vitehub/internal/build/deployment-output"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vitehub/internal/build/paths"
import { resolveUserAppEntry } from "@vitehub/internal/build/user-entry"

import { normalizeBlobOptions } from "../config.ts"

import type { BlobModuleOptions, ResolvedBlobModuleOptions } from "../types.ts"
import type { CloudflareProviderDeploymentOutput, VercelProviderDeploymentOutput } from "@vitehub/internal/build/deployment-output"

export const blobPackageName = "@vitehub/blob"
const productName = "blob"
const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)

const BLOB_ENTRY_NAMES_DEFAULT = ["server.ts", "server.mts", "server.js", "server.mjs", "worker.ts", "worker.mts", "worker.js", "worker.mjs"] as const
const BLOB_ENTRY_NAMES_PRIORITIZED = ["server.blob.ts", "server.blob.mts", "server.blob.js", "server.blob.mjs", ...BLOB_ENTRY_NAMES_DEFAULT] as const

function resolveBlobUserAppEntry(rootDir: string) {
  const names = process.env.VITEHUB_VITE_MODE === "blob" ? BLOB_ENTRY_NAMES_PRIORITIZED : BLOB_ENTRY_NAMES_DEFAULT
  return resolveUserAppEntry(rootDir, { names })
}

type BlobProvider = "cloudflare" | "vercel"

interface ProviderEntrySpec {
  entryFile: string
  factory: string
  hosting: string
  name: BlobProvider
  runtimeModule: string
}

const providerEntrySpecs: ProviderEntrySpec[] = [
  { entryFile: "cloudflare-worker.mjs", factory: "createBlobCloudflareWorker", hosting: "cloudflare", name: "cloudflare", runtimeModule: "runtime/cloudflare-vite" },
  { entryFile: "vercel-server.mjs", factory: "createBlobVercelServer", hosting: "vercel", name: "vercel", runtimeModule: "runtime/vercel-vite" },
]

interface GenerateProviderOutputsOptions {
  blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined
  clientOutDir: string
  rootDir: string
}

interface GeneratedBlobArtifacts {
  cloudflareWorkerFile: string
  generatedDir: string
  runtimeModuleFiles: Record<BlobProvider, string>
  vercelServerFile: string
}

interface CloudflareBlobConfig {
  assets?: { directory?: string, run_worker_first: string[] }
  compatibility_date: string
  compatibility_flags: string[]
  main: string
  name?: string
  observability: { enabled: true }
  r2_buckets?: Array<{ binding: string, bucket_name: string }>
}

function createCloudflareR2Bindings(config: false | ResolvedBlobModuleOptions | undefined) {
  if (!config || config.store.driver !== "cloudflare-r2" || !config.store.bucketName) {
    return undefined
  }

  return [{
    binding: config.store.binding,
    bucket_name: config.store.bucketName,
  }]
}

function resolveBlobConfig(
  blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined,
  hosting: string,
): false | ResolvedBlobModuleOptions {
  return blob && typeof blob === "object" && "store" in blob
    ? blob
    : normalizeBlobOptions(blob, { hosting }) || false
}

function renderProviderEntry(
  spec: ProviderEntrySpec,
  entryFile: string,
  userAppEntry: string | undefined,
  blobConfig: false | ResolvedBlobModuleOptions,
) {
  const imports = [
    `import { setBlobRuntimeConfig, setBlobRuntimeStorage } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("runtime/state")))}`,
    `import { ${spec.factory} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(spec.runtimeModule)))}`,
  ]
  const driverModule = blobConfig ? `drivers/${blobConfig.store.driver === "cloudflare-r2" ? "cloudflare" : blobConfig.store.driver === "fs" ? "fs" : "vercel"}` : undefined
  if (driverModule) {
    imports.push(`import { createBlobStorage } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("storage")))}`)
    imports.push(`import { createDriver } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(driverModule)))}`)
  }
  if (blobConfig && blobConfig.store.driver === "vercel-blob") {
    imports.push(`import { resolveRuntimeVercelBlobStore } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("config")))}`)
  }

  const storageExpression = !blobConfig
    ? undefined
    : blobConfig.store.driver === "vercel-blob"
      ? "createBlobStorage(createDriver(resolveRuntimeVercelBlobStore(blobConfig.store, process.env)))"
      : "createBlobStorage(createDriver(blobConfig.store))"

  const lines = [
    ...imports,
    "",
    `const blobConfig = ${JSON.stringify(blobConfig, null, 2)}`,
    "setBlobRuntimeConfig(blobConfig)",
    storageExpression ? `setBlobRuntimeStorage(${storageExpression})` : "setBlobRuntimeStorage(undefined)",
    userAppEntry ? `const app = (await import(${JSON.stringify(createImportPath(entryFile, userAppEntry))})).default` : "const app = undefined",
    "",
    `export default ${spec.factory}({`,
    "  app,",
    "  blob: blobConfig,",
    "})",
    "",
  ]

  return lines.filter(Boolean).join("\n")
}

function renderBlobRuntimeModule(file: string, blobConfig: false | ResolvedBlobModuleOptions) {
  const imports = [
    `import { ensureBlob } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("ensure")))}`,
    `import { setBlobRuntimeConfig, setBlobRuntimeStorage } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/state")))}`,
  ]
  const driverModule = blobConfig ? `drivers/${blobConfig.store.driver === "cloudflare-r2" ? "cloudflare" : blobConfig.store.driver === "fs" ? "fs" : "vercel"}` : undefined
  if (driverModule) {
    imports.push(`import { createBlobStorage } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("storage")))}`)
    imports.push(`import { createDriver } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule(driverModule)))}`)
  }
  if (blobConfig && blobConfig.store.driver === "vercel-blob") {
    imports.push(`import { resolveRuntimeVercelBlobStore } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("config")))}`)
  }

  const storageExpression = !blobConfig
    ? undefined
    : blobConfig.store.driver === "vercel-blob"
      ? "createBlobStorage(createDriver(resolveRuntimeVercelBlobStore(blobConfig.store, process.env)))"
      : "createBlobStorage(createDriver(blobConfig.store))"

  return [
    ...imports,
    "",
    `const blobConfig = ${JSON.stringify(blobConfig, null, 2)}`,
    "setBlobRuntimeConfig(blobConfig)",
    ...(storageExpression
      ? [
          `export const blob = ${storageExpression}`,
          "setBlobRuntimeStorage(blob)",
        ]
      : [
          "export const blob = undefined",
          "setBlobRuntimeStorage(undefined)",
        ]),
    "export { ensureBlob }",
    "",
  ].join("\n")
}

async function writeProviderEntries(rootDir: string, blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined) {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  await mkdir(generatedDir, { recursive: true })

  const userAppEntry = resolveBlobUserAppEntry(rootDir)
  const entryFiles: Record<BlobProvider, string> = { cloudflare: "", vercel: "" }
  const runtimeModuleFiles: Record<BlobProvider, string> = { cloudflare: "", vercel: "" }

  for (const spec of providerEntrySpecs) {
    const entryFile = resolve(generatedDir, spec.entryFile)
    const runtimeModuleFile = resolve(generatedDir, `${spec.name}-runtime.mjs`)
    const blobConfig = resolveBlobConfig(blob, spec.hosting)
    await writeFile(entryFile, renderProviderEntry(spec, entryFile, userAppEntry, blobConfig), "utf8")
    await writeFile(runtimeModuleFile, renderBlobRuntimeModule(runtimeModuleFile, blobConfig), "utf8")
    entryFiles[spec.name] = entryFile
    runtimeModuleFiles[spec.name] = runtimeModuleFile
  }

  return {
    cloudflareWorkerFile: entryFiles.cloudflare,
    generatedDir,
    runtimeModuleFiles,
    vercelServerFile: entryFiles.vercel,
  } satisfies GeneratedBlobArtifacts
}

function createCloudflareOutput(blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined, artifacts: GeneratedBlobArtifacts): CloudflareProviderDeploymentOutput {
  const resolved = resolveBlobConfig(blob, "cloudflare")

  const wranglerConfig: CloudflareBlobConfig = {
    compatibility_date: defaultCloudflareCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    main: "index.js",
    observability: { enabled: true },
    ...(createCloudflareR2Bindings(resolved) ? { r2_buckets: createCloudflareR2Bindings(resolved) } : {}),
  }

  return {
    bundleEntry: artifacts.cloudflareWorkerFile,
    bundleOptions: {
      alias: {
        "@vitehub/blob": artifacts.runtimeModuleFiles.cloudflare,
      },
      conditions: ["workerd", "worker", "browser", "default"],
      external: ["@vercel/blob", "node:async_hooks", "virtual:@vitehub/blob/config"],
      format: "esm",
      platform: "neutral",
    },
    wranglerConfig,
  }
}

function createVercelOutput(artifacts: GeneratedBlobArtifacts): VercelProviderDeploymentOutput {
  return {
    bundleEntry: artifacts.vercelServerFile,
    bundleOptions: {
      alias: {
        "@vitehub/blob": artifacts.runtimeModuleFiles.vercel,
      },
      external: ["virtual:@vitehub/blob/config"],
      format: "esm",
      platform: "node",
    },
  }
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedBlobArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.blob)
  await writeProviderDeploymentOutputs({
    clientOutDir: options.clientOutDir,
    cloudflare: createCloudflareOutput(options.blob, artifacts),
    rootDir: options.rootDir,
    vercel: createVercelOutput(artifacts),
  })
  return artifacts
}
