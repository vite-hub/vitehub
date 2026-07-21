import { access, cp, mkdir, readFile, realpath, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

import { createDefaultVercelOutputRoot } from "./deployment-output.ts"

import type { VercelFunctionRuntimePackage } from "./vercel-runtime-packages.ts"

export async function copyVercelFunctionRuntimePackageDirectories(options: {
  outputRoot?: string
  packages: VercelFunctionRuntimePackage[]
  rootDir: string
  serverFunctionName?: string
}): Promise<void> {
  if (!options.packages.length) return
  const functionDir = resolve(options.outputRoot ?? createDefaultVercelOutputRoot(options.rootDir), "functions", options.serverFunctionName ?? "__server.func")
  const outputNodeModules = resolve(functionDir, "node_modules")
  const copied = new Set<string>()
  for (const runtimePackage of options.packages) {
    await copyPackageDirectory(runtimePackage.name, runtimePackage.resolveFrom ?? join(options.rootDir, "package.json"), outputNodeModules, copied, runtimePackage.optional)
  }
}

async function copyPackageDirectory(name: string, resolveFrom: string, outputNodeModules: string, copied: Set<string>, optional = false): Promise<void> {
  let resolvedPackageJsonPath: string
  try {
    resolvedPackageJsonPath = await resolvePackageJson(name, dirname(resolveFrom))
  }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  const packageJsonPath = await realpath(resolvedPackageJsonPath)
  if (copied.has(packageJsonPath)) return
  copied.add(packageJsonPath)
  const packageDir = dirname(packageJsonPath)
  const targetDir = join(outputNodeModules, ...name.split("/"))
  await rm(targetDir, { force: true, recursive: true })
  await mkdir(dirname(targetDir), { recursive: true })
  await cp(packageDir, targetDir, {
    dereference: true,
    filter: source => !relative(packageDir, source).split(sep).includes("node_modules"),
    recursive: true,
  })
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { dependencies?: Record<string, string> }
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    await copyPackageDirectory(dependency, packageJsonPath, outputNodeModules, copied)
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
