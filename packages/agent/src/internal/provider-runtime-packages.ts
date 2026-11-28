import Module, { createRequire, findPackageJSON } from "node:module"
import { dirname, join } from "node:path"

import type { NodeRuntimePackage } from "@vite-hub/internal/build/vercel-runtime-packages"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { providerHarnessProfile, providerHarnessProfiles } from "./provider-profiles.ts"
import type { ProviderHarness, ProviderHarnessProfile, ProviderRuntimePackage, ProviderRuntimeTarget } from "./provider-profiles.ts"

type RuntimeLibc = "glibc" | "musl"

declare const __VITEHUB_AGENT_APP_ROOT__: string | undefined

function isPackageResolutionMiss(error: unknown): boolean {
  // SAFETY: Node module resolution failures expose their stable error code through ErrnoException.
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
}

// A candidate root can be unreadable at runtime. The Vite build bakes in its own root, and a
// release that runs from another directory as another user may not read that path or its parents.
// Node then fails while it reads the nearest package.json. Try the next candidate instead.
function isUnreadableCandidate(error: unknown): boolean {
  // SAFETY: Node module resolution failures expose their stable error code through ErrnoException.
  const failure = error as NodeJS.ErrnoException | undefined
  if (failure?.code === "EACCES" || failure?.code === "EPERM") return true
  return failure?.code === "ERR_INVALID_PACKAGE_CONFIG"
    && /permission denied|operation not permitted/i.test(failure.message)
}

// The CommonJS resolver also searches NODE_PATH, which pnpm bin shims set to the hidden
// node_modules/.pnpm/node_modules store of packages the app did not install. Keep
// customized resolvers, but exclude results that only the global search paths provide.
function isInstalledPackage(name: string, resolveFrom: string, packageJsonPath: string): boolean {
  try {
    findPackageJSON(name, resolveFrom)
    return true
  }
  catch (error) {
    if (!isPackageResolutionMiss(error)) throw error
  }
  const resolver = createRequire(resolveFrom)
  // SAFETY: Node exposes the initialized CommonJS global search paths on Module.
  const { globalPaths } = Module as typeof Module & { globalPaths: string[] }
  for (const path of globalPaths) {
    try {
      if (resolver.resolve(join(path, name, "package.json")) === packageJsonPath) return false
    }
    catch (error) {
      if (!isPackageResolutionMiss(error)) throw error
    }
  }
  return true
}

function resolvePackageJson(name: string, resolveFrom: string): string | undefined {
  const resolver = createRequire(resolveFrom)
  let packageJsonPath: string | undefined
  try {
    packageJsonPath = resolver.resolve(`${name}/package.json`)
  }
  catch (error) {
    // SAFETY: Node module resolution failures expose their stable error code through ErrnoException.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      if (!isPackageResolutionMiss(error)) throw error
      return
    }
  }
  if (!packageJsonPath) {
    try {
      packageJsonPath = findPackageJSON(".", resolver.resolve(name))
    }
    catch (error) {
      if (!isPackageResolutionMiss(error)) throw error
    }
  }
  if (packageJsonPath && isInstalledPackage(name, resolveFrom, packageJsonPath)) return packageJsonPath
}

function currentLinuxLibc(): RuntimeLibc {
  // SAFETY: Node's diagnostic report includes the runtime glibc version on glibc-based Linux hosts.
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl"
}

function resolveRuntimeTarget(runtimePackage: ProviderRuntimePackage, platform: string, arch: string, libc?: RuntimeLibc): ProviderRuntimeTarget | undefined {
  return runtimePackage.targets[runtimePackage.libc && platform === "linux" ? `${platform}-${arch}-${libc ?? currentLinuxLibc()}` : `${platform}-${arch}`]
}

function resolveRuntimePackages(options: {
  allowMissingTarget?: boolean
  displayName: string
  includePeerDependencies?: boolean
  packageName: string
  resolveFrom: string
  target?: ProviderRuntimeTarget
}): NodeRuntimePackage[] {
  const packageJsonPath = resolvePackageJson(options.packageName, options.resolveFrom)
  if (!packageJsonPath) return []
  if (!options.target) {
    throw agentDiagnostics.AGENT_R0566({ message: `[vitehub] Cannot package ${options.packageName} for this host. Self-hosted ${options.displayName} builds support macOS and Linux on arm64 or x64.` })
  }
  if (!resolvePackageJson(options.target.packageName, packageJsonPath)) {
    if (options.allowMissingTarget) {
      return [{ ...(options.includePeerDependencies && { includePeerDependencies: true }), name: options.packageName, resolveFrom: options.resolveFrom }]
    }
    throw agentDiagnostics.AGENT_R0567({ message: `[vitehub] ${options.packageName} is installed, but its ${options.target.packageName} optional dependency is missing. Reinstall dependencies on the deployment host before building.` })
  }
  return [
    { ...(options.includePeerDependencies && { includePeerDependencies: true }), name: options.packageName, resolveFrom: options.resolveFrom },
    { name: options.target.packageName, resolveFrom: packageJsonPath },
  ]
}

export function resolveInstalledProviderExecutable(provider: ProviderHarness, options: {
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
  const { runtimePackage } = providerHarnessProfile(provider)
  if (!runtimePackage) return
  if (runtimePackage.executable.kind === "package-file") {
    for (const candidate of candidates) {
      try {
        return createRequire(candidate).resolve(`${runtimePackage.packageName}/${runtimePackage.executable.path}`)
      }
      catch (error) {
        if (!isPackageResolutionMiss(error) && !isUnreadableCandidate(error)) throw error
      }
    }
    return
  }
  const target = resolveRuntimeTarget(runtimePackage, platform, options.arch ?? process.arch, options.libc)
  if (!target?.binary) return
  for (const candidate of candidates) {
    let nativePackageJsonPath: string | undefined
    try {
      const packageJsonPath = resolvePackageJson(runtimePackage.packageName, candidate)
      if (!packageJsonPath) continue
      nativePackageJsonPath = resolvePackageJson(target.packageName, packageJsonPath)
    }
    catch (error) {
      if (!isUnreadableCandidate(error)) throw error
      continue
    }
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
  return Object.values(providerHarnessProfiles).flatMap(({ runtimePackage }: ProviderHarnessProfile) => runtimePackage === undefined ? [] : resolveRuntimePackages({
    allowMissingTarget: runtimePackage.allowMissingTarget,
    displayName: runtimePackage.displayName,
    includePeerDependencies: runtimePackage.includePeerDependencies,
    packageName: runtimePackage.packageName,
    resolveFrom,
    target: resolveRuntimeTarget(runtimePackage, platform, arch, options.libc),
  }))
}
