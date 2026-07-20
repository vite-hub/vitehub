import { access, cp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { builtinModules, createRequire } from "node:module"
import { dirname, extname, join, resolve } from "node:path"


const builtinModuleNames = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])
const runtimeExtensions = new Set([".cjs", ".js", ".mjs", ".ts"])

interface FinalizeDenoDeploymentOutputOptions {
  outputDir?: string
  rootDir: string
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#")
  )
    return
  if (builtinModuleNames.has(specifier) || specifier.includes(":")) return
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

function collectBundledPackageNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(
    /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/\s]+)/g,
  )) {
    const name = packageNameFromSpecifier(match[1]!)
    if (name) names.add(name)
  }
  return names
}

function collectImportedPackageNames(source: string): Set<string> {
  const names = new Set<string>()
  const executableSource = source.replace(/\/\*[\s\S]*?\*\//g, "")
  const patterns = [
    /\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of executableSource.matchAll(pattern)) {
      const name = packageNameFromSpecifier(match[1]!)
      if (name) names.add(name)
    }
  }
  return names
}

export function collectDenoRuntimePackageNames(source: string): string[] {
  return [...new Set([
    ...collectBundledPackageNames(source),
    ...collectImportedPackageNames(source),
  ])].sort()
}

interface RuntimePackage {
  includeOptionalDependencies?: boolean
  includePeerDependencies?: boolean
  name: string
  onlyIfOptionalDependencies?: boolean
  optional?: boolean
}

async function copyRuntimePackagesToNodeModules(options: { outputNodeModules: string, packages: RuntimePackage[], rootDir: string }): Promise<void> {
  const copied = new Set<string>()
  const resolver = createRequire(join(options.rootDir, "package.json"))
  for (const runtimePackage of options.packages) {
    await copyPackageToNodeModules(runtimePackage.name, resolver, options.rootDir, options.outputNodeModules, copied, runtimePackage)
  }
}

async function copyPackageToNodeModules(name: string, resolver: NodeJS.Require, fromDir: string, outputNodeModules: string, copied: Set<string>, options: RuntimePackage): Promise<void> {
  const packageJsonPath = await resolvePackageJson(name, resolver, fromDir)
  if (!packageJsonPath) {
    if (options.optional) return
    throw new Error("Could not resolve package.json for " + name + ".")
  }
  const resolvedPackageJsonPath = await realpath(packageJsonPath)
  const packageDir = dirname(resolvedPackageJsonPath)
  const packageJson = JSON.parse(await readFile(resolvedPackageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }
  if (options.onlyIfOptionalDependencies && !Object.keys(packageJson.optionalDependencies || {}).length) return
  const packageKey = name + "\0" + resolvedPackageJsonPath
  if (!copied.has(packageKey)) {
    copied.add(packageKey)
    const targetDir = join(outputNodeModules, ...name.split("/"))
    await rm(targetDir, { force: true, recursive: true })
    await cp(packageDir, targetDir, { dereference: true, recursive: true })
  }
  const packageRequire = createRequire(resolvedPackageJsonPath)
  const dependencyNames = new Set(Object.keys(packageJson.dependencies || {}))
  if (options.includeOptionalDependencies) {
    for (const dependencyName of Object.keys(packageJson.optionalDependencies || {})) dependencyNames.add(dependencyName)
  }
  if (options.includePeerDependencies) {
    for (const dependencyName of Object.keys(packageJson.peerDependencies || {})) {
      if (!packageJson.peerDependenciesMeta?.[dependencyName]?.optional) dependencyNames.add(dependencyName)
    }
  }
  for (const dependencyName of dependencyNames) {
    await copyPackageToNodeModules(dependencyName, packageRequire, packageDir, outputNodeModules, copied, {
      includeOptionalDependencies: options.includeOptionalDependencies,
      includePeerDependencies: options.includePeerDependencies,
      name: dependencyName,
      optional: Boolean(packageJson.optionalDependencies?.[dependencyName]),
    })
  }
}

async function resolvePackageJson(name: string, resolver: NodeJS.Require, fromDir: string): Promise<string | undefined> {
  try {
    return resolver.resolve(name + "/package.json")
  } catch (error) {
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
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      current = dirname(current)
    }
  } catch (error) {
    if (!isPackageResolutionMiss(error)) throw error
  }
  let current = fromDir
  while (current !== dirname(current)) {
    const candidate = join(current, "node_modules", ...name.split("/"), "package.json")
    try {
      await access(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    current = dirname(current)
  }
}

function isPackageResolutionMiss(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
}

async function runtimeSourceFiles(serverDir: string): Promise<string[]> {
  const entries = await readdir(serverDir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && runtimeExtensions.has(extname(entry.name)))
    .map((entry) => resolve(entry.parentPath, entry.name))
}

async function readRuntimePackages(serverDir: string): Promise<RuntimePackage[]> {
  const packages = new Map<string, RuntimePackage>()
  for (const file of await runtimeSourceFiles(serverDir)) {
    const source = await readFile(file, "utf8")
    for (const name of collectBundledPackageNames(source)) {
      if (!packages.has(name)) {
        packages.set(name, {
          includeOptionalDependencies: true,
          includePeerDependencies: true,
          name,
          onlyIfOptionalDependencies: true,
          optional: true,
        })
      }
    }
    for (const name of collectImportedPackageNames(source)) {
      packages.set(name, {
        includeOptionalDependencies: true,
        includePeerDependencies: true,
        name,
      })
    }
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const denoDeployRunnerSource = `import { spawn } from "node:child_process"

const organization = process.env.DENO_DEPLOY_ORG
const app = process.env.DENO_DEPLOY_APP || process.env.VITEHUB_DEPLOYMENT_NAME
const region = process.env.DENO_DEPLOY_REGION || "global"

if (!organization || !app) {
  throw new Error("DENO_DEPLOY_ORG and DENO_DEPLOY_APP (or VITEHUB_DEPLOYMENT_NAME) are required.")
}

function run(args, stdio = "inherit") {
  return new Promise((resolve, reject) => {
    const child = spawn("deno", args, { cwd: new URL(".", import.meta.url), stdio })
    child.on("error", reject)
    child.on("exit", (code, signal) => resolve({ code, signal }))
  })
}

const lookup = await run(["deploy", "apps", "get", "--org", organization, "--app", app, "--json", "--non-interactive"], "ignore")
if (lookup.code !== 0 && lookup.code !== 4) {
  throw new Error("deno app lookup exited with " + (lookup.signal || "code " + lookup.code))
}

const common = ["--org", organization, "--app", app, "--allow-node-modules", "--json", "--non-interactive"]
const args = lookup.code === 0
  ? ["deploy", ".", ...common]
  : ["deploy", "create", ".", "--source", "local", "--do-not-use-detected-build-config", "--runtime-mode", "dynamic", "--entrypoint", "server/index.ts", "--working-directory", ".", "--region", region, ...common]
const result = await run(args)
if (result.code !== 0) throw new Error("deno deploy exited with " + (result.signal || "code " + result.code))
`

export async function finalizeDenoDeploymentOutput(
  options: FinalizeDenoDeploymentOutputOptions,
): Promise<void> {
  const outputDir = resolve(options.rootDir, options.outputDir ?? ".output")
  const serverDir = join(outputDir, "server")
  const packages = await readRuntimePackages(serverDir)

  await copyRuntimePackagesToNodeModules({
    outputNodeModules: join(outputDir, "node_modules"),
    packages,
    rootDir: options.rootDir,
  })

  const denoConfig = {
    nodeModulesDir: "manual",
    tasks: { start: "deno run -A ./server/index.ts" },
  }
  await writeFile(join(outputDir, "deno.json"), `${JSON.stringify(denoConfig, null, 2)}\n`, "utf8")
  await writeFile(join(outputDir, "deploy.mjs"), denoDeployRunnerSource, "utf8")
}
