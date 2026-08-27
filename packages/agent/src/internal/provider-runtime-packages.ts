import { createRequire, findPackageJSON } from "node:module"
import { dirname, join } from "node:path"

import type { NodeRuntimePackage } from "@vite-hub/internal/build/vercel-runtime-packages"

type ProviderRuntimeKind = "claude-code" | "codex"
type RuntimeLibc = "glibc" | "musl"

interface RuntimeTarget {
  binary?: string
  packageName: string
}

const codexPackageName = "@openai/codex"
const claudePackageName = "@anthropic-ai/claude-agent-sdk"

declare const __VITEHUB_AGENT_APP_ROOT__: string | undefined

const codexTargets: Record<string, RuntimeTarget> = {
  "darwin-arm64": { packageName: "@openai/codex-darwin-arm64" },
  "darwin-x64": { packageName: "@openai/codex-darwin-x64" },
  "linux-arm64": { packageName: "@openai/codex-linux-arm64" },
  "linux-x64": { packageName: "@openai/codex-linux-x64" },
}

const claudeTargets: Record<string, RuntimeTarget> = {
  "darwin-arm64": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-darwin-arm64" },
  "darwin-x64": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-darwin-x64" },
  "linux-arm64-glibc": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-linux-arm64" },
  "linux-arm64-musl": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-linux-arm64-musl" },
  "linux-x64-glibc": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-linux-x64" },
  "linux-x64-musl": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-linux-x64-musl" },
}

function isPackageResolutionMiss(error: unknown): boolean {
  // SAFETY: Node module resolution failures expose their stable error code through ErrnoException.
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
}

function resolvePackageJson(name: string, resolveFrom: string): string | undefined {
  const resolver = createRequire(resolveFrom)
  try {
    return resolver.resolve(`${name}/package.json`)
  }
  catch (error) {
    // SAFETY: Node module resolution failures expose their stable error code through ErrnoException.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      if (!isPackageResolutionMiss(error)) throw error
      return
    }
  }
  try {
    return findPackageJSON(".", resolver.resolve(name))
  }
  catch (error) {
    if (!isPackageResolutionMiss(error)) throw error
  }
}

function currentLinuxLibc(): RuntimeLibc {
  // SAFETY: Node's diagnostic report includes the runtime glibc version on glibc-based Linux hosts.
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl"
}

function resolveClaudeTarget(platform: string, arch: string, libc?: RuntimeLibc): RuntimeTarget | undefined {
  return claudeTargets[platform === "linux" ? `${platform}-${arch}-${libc ?? currentLinuxLibc()}` : `${platform}-${arch}`]
}

function resolveRuntimePackages(options: {
  allowMissingTarget?: boolean
  displayName: string
  packageName: string
  resolveFrom: string
  target?: RuntimeTarget
}): NodeRuntimePackage[] {
  const packageJsonPath = resolvePackageJson(options.packageName, options.resolveFrom)
  if (!packageJsonPath) return []
  if (!options.target) {
    throw new Error(`[vitehub] Cannot package ${options.packageName} for this host. Self-hosted ${options.displayName} builds support macOS and Linux on arm64 or x64.`)
  }
  if (!resolvePackageJson(options.target.packageName, packageJsonPath)) {
    if (options.allowMissingTarget) {
      return [{ name: options.packageName, resolveFrom: options.resolveFrom }]
    }
    throw new Error(`[vitehub] ${options.packageName} is installed, but its ${options.target.packageName} optional dependency is missing. Reinstall dependencies on the deployment host before building.`)
  }
  return [
    { name: options.packageName, resolveFrom: options.resolveFrom },
    { name: options.target.packageName, resolveFrom: packageJsonPath },
  ]
}

export function resolveInstalledProviderExecutable(provider: ProviderRuntimeKind, options: {
  arch?: string
  libc?: RuntimeLibc
  platform?: string
  resolveFrom?: string
} = {}): string | undefined {
  const platform = options.platform ?? process.platform
  if (platform === "win32") return
  let appRoot: string | undefined
  try {
    appRoot = __VITEHUB_AGENT_APP_ROOT__
  }
  catch {
    // The Vite integration replaces this global. Direct imports keep the existing cwd fallback.
  }
  const candidates = options.resolveFrom
    ? [options.resolveFrom]
    : [appRoot && join(appRoot, "package.json"), join(process.cwd(), "package.json"), import.meta.url].filter((candidate): candidate is string => Boolean(candidate))
  if (provider === "codex") {
    for (const candidate of candidates) {
      try {
        return createRequire(candidate).resolve(`${codexPackageName}/bin/codex.js`)
      }
      catch (error) {
        if (!isPackageResolutionMiss(error)) throw error
      }
    }
    return
  }
  const target = resolveClaudeTarget(platform, options.arch ?? process.arch, options.libc)
  if (!target?.binary) return
  for (const candidate of candidates) {
    const packageJsonPath = resolvePackageJson(claudePackageName, candidate)
    if (!packageJsonPath) continue
    const nativePackageJsonPath = resolvePackageJson(target.packageName, packageJsonPath)
    if (nativePackageJsonPath) return join(dirname(nativePackageJsonPath), target.binary)
  }
}

export function resolveProviderRuntimePackages(options: {
  arch?: string
  libc?: RuntimeLibc
  platform?: string
  rootDir: string
}): NodeRuntimePackage[] {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const resolveFrom = join(options.rootDir, "package.json")
  return [
    ...resolveRuntimePackages({
      displayName: "Codex",
      packageName: codexPackageName,
      resolveFrom,
      target: codexTargets[`${platform}-${arch}`],
    }),
    ...resolveRuntimePackages({
      allowMissingTarget: true,
      displayName: "Claude",
      packageName: claudePackageName,
      resolveFrom,
      target: resolveClaudeTarget(platform, arch, options.libc),
    }),
  ]
}
