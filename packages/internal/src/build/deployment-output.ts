import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { copyClientOutput, hasStaticIndex } from "./client-output.ts"
import { bundleEsmEntry } from "./esbuild.ts"
import { toSafeAppName } from "./user-entry.ts"
import { createNodeFunctionConfig, createVercelConfigJson } from "./vercel-config.ts"

type BundleOptions = Parameters<typeof bundleEsmEntry>[2]

interface SharedDeploymentOptions {
  clientOutDir: string
  rootDir: string
}

interface CloudflareDeploymentOutputOptions extends SharedDeploymentOptions {
  bundleEntry: string
  bundleOptions: BundleOptions
  bundleOutfileName?: string
  outputRoot?: string
  staticOutputDir?: string
  wranglerConfig: object
}

interface VercelDeploymentOutputOptions extends SharedDeploymentOptions {
  bundleEntry: string
  bundleOptions: BundleOptions
  config?: object
  functionConfig?: object
  outputRoot?: string
  serverFunctionName?: string
  staticOutputDir?: string
}

export type CloudflareProviderDeploymentOutput = Omit<CloudflareDeploymentOutputOptions, keyof SharedDeploymentOptions>
export type VercelProviderDeploymentOutput = Omit<VercelDeploymentOutputOptions, keyof SharedDeploymentOptions>

interface ProviderDeploymentOutputOptions extends SharedDeploymentOptions {
  cloudflare?: CloudflareProviderDeploymentOutput
  vercel?: VercelProviderDeploymentOutput
}

interface ResolvedClientOutput {
  clientDir: string
  staticIndex: boolean
}

function resolveClientOutput(rootDir: string, clientOutDir: string): ResolvedClientOutput {
  const clientDir = resolve(rootDir, clientOutDir)
  return {
    clientDir,
    staticIndex: hasStaticIndex(clientDir),
  }
}

export function shouldSkipViteProviderBuild(command: "build" | "serve" | undefined, mode?: string): boolean {
  return command === "serve" || mode === "e2e"
}

export function createDefaultCloudflareOutputRoot(rootDir: string): string {
  return resolve(rootDir, "dist", toSafeAppName(rootDir))
}

function createDefaultCloudflareStaticOutputDir(rootDir: string): string {
  return resolve(rootDir, "dist", "client")
}

export function createDefaultVercelOutputRoot(rootDir: string): string {
  return resolve(rootDir, ".vercel", "output")
}

async function writeCloudflareDeploymentOutput(options: CloudflareDeploymentOutputOptions): Promise<void> {
  const { clientDir, staticIndex } = resolveClientOutput(options.rootDir, options.clientOutDir)
  const outputRoot = options.outputRoot ?? createDefaultCloudflareOutputRoot(options.rootDir)
  const workerOutfile = resolve(outputRoot, options.bundleOutfileName ?? "index.js")

  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(outputRoot, { recursive: true })

  await Promise.all([
    bundleEsmEntry(options.bundleEntry, workerOutfile, options.bundleOptions),
    writeFile(resolve(outputRoot, "wrangler.json"), `${JSON.stringify(options.wranglerConfig, null, 2)}\n`, "utf8"),
    staticIndex
      ? copyClientOutput(clientDir, options.staticOutputDir ?? createDefaultCloudflareStaticOutputDir(options.rootDir))
      : Promise.resolve(),
  ])
}

async function writeVercelDeploymentOutput(options: VercelDeploymentOutputOptions): Promise<void> {
  const { clientDir, staticIndex } = resolveClientOutput(options.rootDir, options.clientOutDir)
  const outputRoot = options.outputRoot ?? createDefaultVercelOutputRoot(options.rootDir)
  const serverFunctionName = options.serverFunctionName ?? "__server.func"
  const serverDir = resolve(outputRoot, "functions", serverFunctionName)
  const serverEntry = resolve(serverDir, "index.mjs")

  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(serverDir, { recursive: true })

  await Promise.all([
    bundleEsmEntry(options.bundleEntry, serverEntry, options.bundleOptions),
    writeFile(resolve(serverDir, ".vc-config.json"), `${JSON.stringify(options.functionConfig ?? createNodeFunctionConfig(), null, 2)}\n`, "utf8"),
    writeFile(resolve(outputRoot, "config.json"), `${JSON.stringify(options.config ?? createVercelConfigJson(), null, 2)}\n`, "utf8"),
    staticIndex
      ? copyClientOutput(clientDir, options.staticOutputDir ?? resolve(outputRoot, "static"))
      : Promise.resolve(),
  ])
}

export async function writeProviderDeploymentOutputs(options: ProviderDeploymentOutputOptions): Promise<void> {
  const writes: Array<Promise<void>> = []
  if (options.cloudflare) {
    writes.push(writeCloudflareDeploymentOutput({
      ...options.cloudflare,
      clientOutDir: options.clientOutDir,
      rootDir: options.rootDir,
    }))
  }
  if (options.vercel) {
    writes.push(writeVercelDeploymentOutput({
      ...options.vercel,
      clientOutDir: options.clientOutDir,
      rootDir: options.rootDir,
    }))
  }
  await Promise.all(writes)
}
