import { access, cp, mkdir, readFile, realpath, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

import { updateRuntimePackageDirectory } from "./runtime-package-directory.ts"
import { createDefaultVercelOutputRoot } from "./deployment-output.ts"

import type { VercelFunctionRuntimePackage } from "./vercel-runtime-packages.ts"
import { internalErrorDiagnostics } from "../error-diagnostics.ts"

export async function copyVercelFunctionRuntimePackageDirectories(options: {
  outputRoot?: string
  packages: VercelFunctionRuntimePackage[]
  rootDir: string
  serverFunctionName?: string
  signal?: AbortSignal
}): Promise<void> {
  if (!options.packages.length) return
  const functionDir = resolve(options.outputRoot ?? createDefaultVercelOutputRoot(options.rootDir), "functions", options.serverFunctionName ?? "__server.func")
  await updateRuntimePackageDirectory({
    directory: resolve(functionDir, "node_modules"),
    signal: options.signal,
    async update(stagedNodeModules) {
      const copied = new Map<string, string>()
      const selected = new Map<string, string>()
      for (const runtimePackage of options.packages) {
        try {
          selected.set(runtimePackage.name, await realpath(await resolvePackageJson(runtimePackage.name, dirname(runtimePackage.resolveFrom ?? join(options.rootDir, "package.json")))))
        }
        catch (error) {
          // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
          if (!runtimePackage.optional || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      for (const runtimePackage of options.packages) {
        await copyPackageDirectory(runtimePackage.name, runtimePackage.resolveFrom ?? join(options.rootDir, "package.json"), stagedNodeModules, copied, selected, runtimePackage.optional)
      }
    },
  })
}

async function copyPackageDirectory(name: string, resolveFrom: string, outputNodeModules: string, copied: Map<string, string>, selected: Map<string, string>, optional = false, conflictNodeModules?: string): Promise<void> {
  let resolvedPackageJsonPath: string
  try {
    resolvedPackageJsonPath = await resolvePackageJson(name, dirname(resolveFrom))
  }
  catch (error) {
    // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
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
  const parsedPackageJson: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"))
  const packageJson = parsePackageJson(parsedPackageJson, packageJsonPath)
  const dependencies = packageJson.dependencies === undefined
    ? {}
    : parsePackageJson(packageJson.dependencies, `${packageJsonPath} dependencies`)
  for (const dependency of Object.keys(dependencies)) {
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
      // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    current = dirname(current)
  }
  // SAFETY: NodeJS.ErrnoException extends Error with the mutable filesystem error code assigned below.
  const error = internalErrorDiagnostics.INTERNAL_B0044({ message: `Could not resolve package.json for ${name}.` }) as NodeJS.ErrnoException
  error.code = "ENOENT"
  throw error
}

function parsePackageJson(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw internalErrorDiagnostics.INTERNAL_B0045({ message: `Expected ${path} to contain a JSON object.` })
  }
  // SAFETY: The checks above establish a non-null, non-array object with string keys.
  return value as Record<string, unknown>
}
