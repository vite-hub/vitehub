import { createRequire } from "node:module"
import { join } from "node:path"

import type { NodeRuntimePackage } from "@vite-hub/internal/build/vercel-runtime-packages"

const codexPackageName = "@openai/codex"

declare const __VITEHUB_AGENT_APP_ROOT__: string | undefined

const codexPlatformPackages: Record<string, string> = {
  "darwin-arm64": "@openai/codex-darwin-arm64",
  "darwin-x64": "@openai/codex-darwin-x64",
  "linux-arm64": "@openai/codex-linux-arm64",
  "linux-x64": "@openai/codex-linux-x64",
}

function isPackageResolutionMiss(error: unknown): boolean {
  // SAFETY: Node module resolution failures expose their stable error code through ErrnoException.
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
}

export function resolveInstalledCodexExecutable(resolveFrom?: string, platform = process.platform): string | undefined {
  if (platform === "win32") return
  let appRoot: string | undefined
  try {
    appRoot = __VITEHUB_AGENT_APP_ROOT__
  }
  catch {
    // The Vite integration replaces this global. Direct imports keep the existing cwd fallback.
  }
  const candidates = resolveFrom
    ? [resolveFrom]
    : [appRoot && join(appRoot, "package.json"), join(process.cwd(), "package.json"), import.meta.url].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    try {
      return createRequire(candidate).resolve(`${codexPackageName}/bin/codex.js`)
    }
    catch (error) {
      if (!isPackageResolutionMiss(error)) throw error
    }
  }
}

export function resolveCodexRuntimePackages(options: {
  arch?: string
  platform?: string
  rootDir: string
}): NodeRuntimePackage[] {
  const resolveFrom = join(options.rootDir, "package.json")
  const resolver = createRequire(resolveFrom)
  let packageJsonPath: string
  try {
    packageJsonPath = resolver.resolve(`${codexPackageName}/package.json`)
  }
  catch (error) {
    if (isPackageResolutionMiss(error)) return []
    throw error
  }

  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const platformPackage = codexPlatformPackages[`${platform}-${arch}`]
  if (!platformPackage) {
    throw new Error(`[vitehub] Cannot package ${codexPackageName} for ${platform}/${arch}. Self-hosted Codex builds support macOS and Linux on arm64 or x64.`)
  }

  try {
    createRequire(packageJsonPath).resolve(`${platformPackage}/package.json`)
  }
  catch (error) {
    if (!isPackageResolutionMiss(error)) throw error
    throw new Error(`[vitehub] ${codexPackageName} is installed, but its ${platformPackage} optional dependency is missing. Reinstall dependencies on the deployment target before building.`)
  }

  return [
    { name: codexPackageName, resolveFrom },
    { name: platformPackage, resolveFrom: packageJsonPath },
  ]
}
