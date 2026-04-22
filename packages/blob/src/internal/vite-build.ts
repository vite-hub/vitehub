import { existsSync } from "node:fs"
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { build as bundle } from "esbuild"

import { normalizeBlobOptions } from "../config.ts"

import type { BlobModuleOptions, ResolvedBlobModuleOptions } from "../types.ts"

export const blobPackageName = "@vitehub/blob"
const defaultCompatibilityDate = "2026-04-20"
const generatedDirSegments = [".vitehub", "blob"] as const
const currentFileDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(currentFileDir, basename(currentFileDir) === "internal" ? "../.." : "..")

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

function ensureGeneratedDir(rootDir: string) {
  return resolve(rootDir, ...generatedDirSegments)
}

function createImportPath(fromFile: string, targetFile: string) {
  const importPath = relative(dirname(fromFile), targetFile).replace(/\\/g, "/")
  return importPath.startsWith(".") ? importPath : `./${importPath}`
}

function resolveRuntimeModule(modulePath: string) {
  const distFile = resolve(packageDir, "dist", `${modulePath}.js`)
  return existsSync(distFile) ? distFile : resolve(packageDir, "src", `${modulePath}.ts`)
}

function resolveUserAppEntry(rootDir: string) {
  const names = process.env.VITEHUB_VITE_MODE === "blob"
    ? ["server.blob.ts", "server.blob.mts", "server.blob.js", "server.blob.mjs", "server.ts", "server.mts", "server.js", "server.mjs", "worker.ts", "worker.mts", "worker.js", "worker.mjs"]
    : ["server.ts", "server.mts", "server.js", "server.mjs", "worker.ts", "worker.mts", "worker.js", "worker.mjs"]

  return names.map(name => resolve(rootDir, "src", name)).find(existsSync)
}

function toGeneratedWorkerPath(rootDir: string, filename: string) {
  return relative(rootDir, resolve(rootDir, ...generatedDirSegments, filename)).replace(/\\/g, "/")
}

function toSafeAppName(rootDir: string) {
  return basename(rootDir).replace(/[^a-z0-9-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase()
}

function hasStaticIndex(clientDir: string) {
  return existsSync(resolve(clientDir, "index.html"))
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

function resolveDriverModule(config: false | ResolvedBlobModuleOptions) {
  if (!config) {
    return undefined
  }

  switch (config.store.driver) {
    case "cloudflare-r2":
      return "drivers/cloudflare"
    case "fs":
      return "drivers/fs"
    case "vercel-blob":
      return "drivers/vercel"
  }
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
    `import { createBlobStorage } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("storage")))}`,
    `import { setBlobRuntimeConfig, setBlobRuntimeStorage } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("runtime/state")))}`,
    `import { ${spec.factory} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(spec.runtimeModule)))}`,
  ]

  const driverModule = resolveDriverModule(blobConfig)
  if (driverModule) {
    imports.push(`import { createDriver } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(driverModule)))}`)
  }

  const lines = [
    ...imports,
    "",
    `const blobConfig = ${JSON.stringify(blobConfig, null, 2)}`,
    "setBlobRuntimeConfig(blobConfig)",
    driverModule ? "setBlobRuntimeStorage(createBlobStorage(createDriver(blobConfig.store)))" : "",
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
  const driverModule = resolveDriverModule(blobConfig)

  return [
    `import { ensureBlob } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("ensure")))}`,
    `import { setBlobRuntimeConfig, setBlobRuntimeStorage } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/state")))}`,
    ...(driverModule
      ? [
          `import { createBlobStorage } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("storage")))}`,
          `import { createDriver } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule(driverModule)))}`,
        ]
      : []),
    "",
    `const blobConfig = ${JSON.stringify(blobConfig, null, 2)}`,
    "setBlobRuntimeConfig(blobConfig)",
    ...(driverModule
      ? [
          "export const blob = createBlobStorage(createDriver(blobConfig.store))",
          "setBlobRuntimeStorage(blob)",
        ]
      : [
          "export const blob = undefined",
        ]),
    "export { ensureBlob }",
    "",
  ].join("\n")
}

async function writeProviderEntries(rootDir: string, blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined) {
  const generatedDir = ensureGeneratedDir(rootDir)
  await mkdir(generatedDir, { recursive: true })

  const userAppEntry = resolveUserAppEntry(rootDir)
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

async function bundleEsmEntry(
  entryFile: string,
  outfile: string,
  options: {
    alias?: Record<string, string>
    conditions?: string[]
    external?: string[]
    format?: "esm" | "cjs"
    platform?: "browser" | "node" | "neutral"
  } = {},
) {
  const format = options.format || "esm"
  const platform = options.platform || "neutral"

  await bundle({
    banner: format === "esm" && platform === "node"
      ? {
          js: 'import { createRequire as __createRequire } from "node:module";\nvar require = __createRequire(import.meta.url);\n',
        }
      : undefined,
    alias: options.alias,
    bundle: true,
    conditions: options.conditions,
    entryPoints: [entryFile],
    external: options.external,
    format,
    logLevel: "silent",
    outfile,
    platform,
    sourcemap: false,
    target: "es2022",
    write: true,
  })
}

async function copyClientOutput(clientDir: string, targetDir: string) {
  const resolvedClientDir = resolve(clientDir)
  const resolvedTargetDir = resolve(targetDir)
  if (resolvedClientDir === resolvedTargetDir) {
    return
  }

  await rm(resolvedTargetDir, { force: true, recursive: true })
  await mkdir(dirname(resolvedTargetDir), { recursive: true })

  const targetRelativePath = relative(resolvedClientDir, resolvedTargetDir).replace(/\\/g, "/")
  if (targetRelativePath && !targetRelativePath.startsWith("../")) {
    const [targetRootEntry] = targetRelativePath.split("/", 1)
    await mkdir(resolvedTargetDir, { recursive: true })
    await Promise.all((await readdir(resolvedClientDir))
      .filter(entry => entry !== targetRootEntry)
      .map(entry => cp(resolve(resolvedClientDir, entry), resolve(resolvedTargetDir, entry), { recursive: true })))
    return
  }

  await cp(resolvedClientDir, resolvedTargetDir, { recursive: true })
}

function createVercelConfigJson() {
  return {
    routes: [
      { handle: "filesystem" },
      { src: "/(.*)", dest: "/__server" },
    ],
    version: 3,
  }
}

function createNodeFunctionConfig(extra: Record<string, unknown> = {}) {
  return {
    handler: "index.mjs",
    launcherType: "Nodejs",
    runtime: "nodejs24.x",
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    ...extra,
  }
}

async function writeCloudflareOutput(rootDir: string, clientOutDir: string, blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined, artifacts: GeneratedBlobArtifacts) {
  const clientDir = resolve(rootDir, clientOutDir)
  const outputRoot = resolve(rootDir, "dist", toSafeAppName(rootDir))
  const workerOutfile = resolve(outputRoot, "index.js")
  const staticIndex = hasStaticIndex(clientDir)
  const resolved = resolveBlobConfig(blob, "cloudflare")

  await rm(outputRoot, { force: true, recursive: true })
  if (staticIndex) {
    await copyClientOutput(clientDir, resolve(rootDir, "dist", "client"))
  }

  await mkdir(outputRoot, { recursive: true })
  await bundleEsmEntry(artifacts.cloudflareWorkerFile, workerOutfile, {
    alias: {
      "@vitehub/blob": artifacts.runtimeModuleFiles.cloudflare,
    },
    conditions: ["workerd", "worker", "browser", "default"],
    external: ["@vercel/blob", "virtual:@vitehub/blob/config"],
    format: "esm",
    platform: "neutral",
  })

  const wranglerConfig: CloudflareBlobConfig = {
    compatibility_date: defaultCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    main: "index.js",
    name: toSafeAppName(rootDir),
    observability: { enabled: true },
    ...(staticIndex ? { assets: { directory: "../client", run_worker_first: ["/api/*"] } } : {}),
    ...(createCloudflareR2Bindings(resolved) ? { r2_buckets: createCloudflareR2Bindings(resolved) } : {}),
  }

  await writeFile(resolve(outputRoot, "wrangler.json"), `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8")
}

async function writeVercelOutput(rootDir: string, clientOutDir: string, artifacts: GeneratedBlobArtifacts) {
  const clientDir = resolve(rootDir, clientOutDir)
  const outputRoot = resolve(rootDir, ".vercel", "output")
  const serverDir = resolve(outputRoot, "functions", "__server.func")
  const serverEntry = resolve(serverDir, "index.mjs")
  const staticIndex = hasStaticIndex(clientDir)

  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(serverDir, { recursive: true })

  await bundleEsmEntry(artifacts.vercelServerFile, serverEntry, {
    alias: {
      "@vitehub/blob": artifacts.runtimeModuleFiles.vercel,
    },
    external: ["virtual:@vitehub/blob/config"],
    format: "esm",
    platform: "node",
  })

  await writeFile(resolve(serverDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8")
  await writeFile(resolve(outputRoot, "config.json"), `${JSON.stringify(createVercelConfigJson(), null, 2)}\n`, "utf8")

  if (staticIndex) {
    await copyClientOutput(clientDir, resolve(outputRoot, "static"))
  }
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedBlobArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.blob)
  await writeCloudflareOutput(options.rootDir, options.clientOutDir, options.blob, artifacts)
  await writeVercelOutput(options.rootDir, options.clientOutDir, artifacts)
  return artifacts
}
