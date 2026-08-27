import { access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

import { createDefaultVercelOutputRoot } from "./deployment-output.ts"

import type { VercelFunctionRuntimePackage } from "./vercel-runtime-packages.ts"

export async function copyVercelFunctionRuntimePackageDirectories(options: {
  outputRoot?: string
  packages: VercelFunctionRuntimePackage[]
  rootDir: string
  serverFunctionName?: string
  signal?: AbortSignal
}): Promise<void> {
  if (!options.packages.length) return
  const functionDir = resolve(options.outputRoot ?? createDefaultVercelOutputRoot(options.rootDir), "functions", options.serverFunctionName ?? "__server.func")
  const outputNodeModules = resolve(functionDir, "node_modules")
  const stagingRoot = await mkdtemp(resolve(functionDir, ".vitehub-runtime-package-directories-"))
  const stagedNodeModules = resolve(stagingRoot, "node_modules")
  const previousNodeModules = resolve(stagingRoot, "previous-node_modules")
  let movedPreviousOutput = false
  let installedReplacement = false

  try {
    try {
      await cp(outputNodeModules, stagedNodeModules, { recursive: true })
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await mkdir(stagedNodeModules, { recursive: true })

    const copied = new Map<string, string>()
    const selected = new Map<string, string>()
    for (const runtimePackage of options.packages) {
      try {
        selected.set(runtimePackage.name, await realpath(await resolvePackageJson(runtimePackage.name, dirname(runtimePackage.resolveFrom ?? join(options.rootDir, "package.json")))))
      }
      catch (error) {
        if (!runtimePackage.optional || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    for (const runtimePackage of options.packages) {
      await copyPackageDirectory(runtimePackage.name, runtimePackage.resolveFrom ?? join(options.rootDir, "package.json"), stagedNodeModules, copied, selected, runtimePackage.optional)
    }
    options.signal?.throwIfAborted()

    try {
      await rename(outputNodeModules, previousNodeModules)
      movedPreviousOutput = true
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    try {
      options.signal?.throwIfAborted()
      await rename(stagedNodeModules, outputNodeModules)
      installedReplacement = true
      options.signal?.throwIfAborted()
    }
    catch (error) {
      if (installedReplacement) await rm(outputNodeModules, { force: true, recursive: true })
      if (movedPreviousOutput) await rename(previousNodeModules, outputNodeModules)
      throw error
    }
  }
  finally {
    await rm(stagingRoot, { force: true, recursive: true })
  }
}

async function copyPackageDirectory(name: string, resolveFrom: string, outputNodeModules: string, copied: Map<string, string>, selected: Map<string, string>, optional = false, conflictNodeModules?: string): Promise<void> {
  let resolvedPackageJsonPath: string
  try {
    resolvedPackageJsonPath = await resolvePackageJson(name, dirname(resolveFrom))
  }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  const packageJsonPath = await realpath(resolvedPackageJsonPath)
  const packageDir = dirname(packageJsonPath)
  let targetDir = join(outputNodeModules, ...name.split("/"))
  const selectedPackage = selected.get(name)
  const existingPackage = copied.get(targetDir)
  if ((selectedPackage && selectedPackage !== packageJsonPath) || (existingPackage && existingPackage !== packageJsonPath)) {
    if (!conflictNodeModules) return
    targetDir = join(conflictNodeModules, ...name.split("/"))
  }
  if (copied.get(targetDir) === packageJsonPath) return
  copied.set(targetDir, packageJsonPath)
  await rm(targetDir, { force: true, recursive: true })
  await mkdir(dirname(targetDir), { recursive: true })
  await cp(packageDir, targetDir, {
    dereference: true,
    filter: source => !relative(packageDir, source).split(sep).includes("node_modules"),
    recursive: true,
  })
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { dependencies?: Record<string, string> }
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    await copyPackageDirectory(dependency, packageJsonPath, outputNodeModules, copied, selected, false, join(targetDir, "node_modules"))
  }
}

async function resolvePackageJson(name: string, fromDir: string): Promise<string> {
  let current = await realpath(fromDir).catch(() => fromDir)
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
  const error = new Error(`Could not resolve package.json for ${name}.`) as NodeJS.ErrnoException
  error.code = "ENOENT"
  throw error
}
