import { access, cp, mkdir, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"

import { createDefaultVercelOutputRoot } from "./deployment-output.ts"

interface VercelFunctionRuntimePackage {
  includePeerDependencies?: boolean
  name: string
  optional?: boolean
  resolveFrom?: string
}

interface VercelFunctionRuntimePackagesOptions {
  outputRoot?: string
  packages: VercelFunctionRuntimePackage[]
  rootDir: string
  serverFunctionName?: string
}

export async function copyVercelFunctionRuntimePackages(options: VercelFunctionRuntimePackagesOptions): Promise<void> {
  if (!options.packages.length) return

  const outputRoot = options.outputRoot ?? createDefaultVercelOutputRoot(options.rootDir)
  const serverFunctionName = options.serverFunctionName ?? "__server.func"
  const serverDir = resolve(outputRoot, "functions", serverFunctionName)
  try {
    await access(serverDir)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }

  const copied = new Set<string>()
  const outputNodeModules = resolve(serverDir, "node_modules")
  for (const runtimePackage of options.packages) {
    const resolver = createRequire(runtimePackage.resolveFrom ?? join(options.rootDir, "package.json"))
    await copyPackageToNodeModules(runtimePackage.name, resolver, options.rootDir, outputNodeModules, copied, runtimePackage)
  }
}

async function copyPackageToNodeModules(
  name: string,
  resolver: NodeJS.Require,
  fromDir: string,
  outputNodeModules: string,
  copied: Set<string>,
  options: VercelFunctionRuntimePackage = { name },
): Promise<void> {
  const packageJsonPath = await resolvePackageJson(name, resolver, fromDir)
  if (!packageJsonPath) {
    if (options.optional) return
    throw new Error(`Could not resolve package.json for ${name}.`)
  }

  const packageDir = dirname(packageJsonPath)
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>
    name?: string
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }
  const packageKey = `${name}\0${packageJsonPath}`

  if (!copied.has(packageKey)) {
    copied.add(packageKey)
    const targetDir = join(outputNodeModules, ...name.split("/"))
    await rm(targetDir, { force: true, recursive: true })
    await mkdir(dirname(targetDir), { recursive: true })
    await cp(packageDir, targetDir, {
      dereference: true,
      filter: source => !relative(packageDir, source).split(sep).includes("node_modules"),
      recursive: true,
    })
  }

  const packageRequire = createRequire(packageJsonPath)
  const dependencyNames = new Set(Object.keys(packageJson.dependencies || {}))
  if (options.includePeerDependencies) {
    for (const dependencyName of Object.keys(packageJson.peerDependencies || {})) {
      if (!packageJson.peerDependenciesMeta?.[dependencyName]?.optional) dependencyNames.add(dependencyName)
    }
  }

  for (const dependencyName of dependencyNames) {
    await copyPackageToNodeModules(dependencyName, packageRequire, packageDir, outputNodeModules, copied, {
      includePeerDependencies: options.includePeerDependencies,
      name: dependencyName,
    })
  }
}

async function resolvePackageJson(name: string, resolver: NodeJS.Require, fromDir: string): Promise<string | undefined> {
  try {
    return resolver.resolve(`${name}/package.json`)
  }
  catch (error) {
    if (!isPackageResolutionMiss(error)) throw error
  }

  try {
    let current = dirname(resolver.resolve(name))
    while (current !== dirname(current)) {
      const candidate = join(current, "package.json")
      try {
        await access(candidate)
        const packageJson = JSON.parse(await readFile(candidate, "utf8")) as { name?: string }
        if (packageJson.name === name) return candidate
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      current = dirname(current)
    }
  }
  catch (error) {
    if (!isPackageResolutionMiss(error)) throw error
  }

  let current = fromDir
  while (current !== dirname(current)) {
    const candidate = join(current, "node_modules", ...name.split("/"), "package.json")
    try {
      await access(candidate)
      return candidate
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    current = dirname(current)
  }
}

function isPackageResolutionMiss(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
}
