import { access, cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { builtinModules, createRequire } from "node:module"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { bundleEsmEntry, type ViteAlias } from "./esbuild.ts"

const builtinModuleNames = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])
const runtimeExtensions = new Set([".cjs", ".js", ".mjs", ".ts"])
const denoRuntimeTargets = [
  { cpu: "arm64", libc: "glibc", os: "linux" },
  { cpu: "x64", libc: "glibc", os: "linux" },
] as const

interface FinalizeDenoDeploymentOutputOptions {
  alias?: ViteAlias[]
  deploymentName?: string
  hasCustomAliasResolver?: boolean
  hasScheduleIntegration?: boolean
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

function collectBundledPackages(source: string): Map<string, string> {
  const packages = new Map<string, string>()
  for (const match of source.matchAll(
    /(?:^|[\s"'`(])((?:[A-Za-z]:)?[^\s"'`()]*?node_modules[/\\](?:\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?((?:@[^/\\]+[/\\])?[^/\\\s"'`()]+))/gm,
  )) {
    const name = packageNameFromSpecifier(match[2]!.replaceAll("\\", "/"))
    if (name) packages.set(name, match[1]!)
  }
  return packages
}

function collectImportedPackageNames(source: string): Set<string> {
  const names = new Set<string>()
  const executableSource = maskInertImportText(source)
  const patterns = [
    /(?:^|;)\s*(?:import|export)\s*["']([^"']+)["']/gm,
    /(?:^|;)\s*(?:import|export)[^;\n]*?\bfrom\s*["']([^"']+)["']/gm,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of executableSource.matchAll(pattern)) {
      const name = packageNameFromSpecifier(match[1]!)
      if (name) names.add(name)
    }
  }
  return names
}

function maskInertImportText(source: string): string {
  let output = ""
  for (let index = 0; index < source.length;) {
    const character = source[index]!
    const next = source[index + 1]
    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", index)
      const length = (end === -1 ? source.length : end) - index
      output += " ".repeat(length)
      index += length
      continue
    }
    if (character === "/" && next === "*") {
      const closing = source.indexOf("*/", index + 2)
      const length = (closing === -1 ? source.length : closing + 2) - index
      output += source.slice(index, index + length).replace(/[^\n]/g, " ")
      index += length
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      const prefix = output.slice(Math.max(0, output.length - 120))
      const keep = character !== "`" && /(?:\b(?:from|import|export)|\b(?:import|require)\s*\(|\bnew\s+URL\s*\()\s*$/.test(prefix)
      let end = index + 1
      while (end < source.length) {
        if (source[end] === "\\") end += 2
        else if (source[end++] === character) break
      }
      const literal = source.slice(index, end)
      output += keep ? literal : literal.replace(/[^\n]/g, " ")
      index = end
      continue
    }
    output += character
    index++
  }
  return output
}

export function collectDenoRuntimePackageNames(source: string): string[] {
  return [...new Set([
    ...collectBundledPackageNames(source),
    ...collectImportedPackageNames(source),
  ])].sort()
}

interface RuntimePackage {
  hoistOptionalDependencies?: boolean
  includeOptionalDependencies?: boolean
  includePeerDependencies?: boolean
  name: string
  onlyIfOptionalDependencies?: boolean
  optional?: boolean
  packageJsonPath?: string
}

interface RuntimePackageJson {
  cpu?: string[]
  dependencies?: Record<string, string>
  libc?: string[]
  optionalDependencies?: Record<string, string>
  os?: string[]
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

async function copyRuntimePackagesToNodeModules(options: { outputNodeModules: string, packages: RuntimePackage[], rootDir: string }): Promise<void> {
  const copied = new Set<string>()
  const staged = new Set<string>()
  const resolver = createRequire(join(options.rootDir, "package.json"))
  for (const runtimePackage of options.packages) {
    await copyPackageToNodeModules(runtimePackage.name, resolver, options.rootDir, options.outputNodeModules, copied, staged, runtimePackage)
  }
}

async function copyPackageToNodeModules(name: string, resolver: NodeJS.Require, fromDir: string, outputNodeModules: string, copied: Set<string>, staged: Set<string>, options: RuntimePackage): Promise<void> {
  let packageJsonPath = options.packageJsonPath
  if (packageJsonPath) {
    try {
      await access(packageJsonPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      packageJsonPath = undefined
    }
  }
  packageJsonPath ??= await resolvePackageJson(name, resolver, fromDir)
  if (!packageJsonPath) {
    if (options.optional) return
    throw new Error("Could not resolve package.json for " + name + ".")
  }
  const resolvedPackageJsonPath = await realpath(packageJsonPath)
  const packageDir = dirname(resolvedPackageJsonPath)
  const packageJson = JSON.parse(await readFile(resolvedPackageJsonPath, "utf8")) as RuntimePackageJson
  if (options.onlyIfOptionalDependencies && !Object.keys(packageJson.optionalDependencies || {}).length) return
  const packageKey = name + "\0" + resolvedPackageJsonPath
  if (copied.has(packageKey)) return
  const targetDir = join(outputNodeModules, ...name.split("/"))
  const stagedKey = packageKey + "\0" + targetDir
  if (staged.has(stagedKey)) return
  copied.add(packageKey)
  await rm(targetDir, { force: true, recursive: true })
  await cp(packageDir, targetDir, {
    dereference: true,
    filter: source => relative(packageDir, source).split(sep)[0] !== "node_modules",
    recursive: true,
  })
  staged.add(stagedKey)
  const packageRequire = createRequire(resolvedPackageJsonPath)
  const optionalDependencyNames = new Set(Object.keys(packageJson.optionalDependencies || {}))
  const dependencyNames = new Set(
    Object.keys(packageJson.dependencies || {}).filter(dependencyName => !optionalDependencyNames.has(dependencyName)),
  )
  if (options.includeOptionalDependencies) {
    for (const dependencyName of Object.keys(packageJson.optionalDependencies || {})) {
      const dependencyPackageJsonPath = await resolvePackageJson(dependencyName, packageRequire, packageDir)
      if (!dependencyPackageJsonPath) continue
      const dependencyPackageJson = JSON.parse(await readFile(dependencyPackageJsonPath, "utf8")) as RuntimePackageJson
      if (supportsDenoRuntime(dependencyPackageJson)) dependencyNames.add(dependencyName)
    }
  }
  if (options.includePeerDependencies) {
    for (const dependencyName of Object.keys(packageJson.peerDependencies || {})) {
      if (!packageJson.peerDependenciesMeta?.[dependencyName]?.optional) dependencyNames.add(dependencyName)
    }
  }
  for (const dependencyName of dependencyNames) {
    const dependencyNodeModules = options.hoistOptionalDependencies && packageJson.optionalDependencies?.[dependencyName]
      ? outputNodeModules
      : join(targetDir, "node_modules")
    await copyPackageToNodeModules(dependencyName, packageRequire, packageDir, dependencyNodeModules, copied, staged, {
      hoistOptionalDependencies: options.hoistOptionalDependencies && Boolean(packageJson.optionalDependencies?.[dependencyName]),
      includeOptionalDependencies: options.includeOptionalDependencies,
      includePeerDependencies: options.includePeerDependencies,
      name: dependencyName,
      optional: Boolean(packageJson.optionalDependencies?.[dependencyName]),
    })
  }
  copied.delete(packageKey)
}

function supportsDenoRuntime(packageJson: RuntimePackageJson): boolean {
  return denoRuntimeTargets.some(target =>
    supportsConstraint(packageJson.os, target.os)
    && supportsConstraint(packageJson.cpu, target.cpu)
    && supportsConstraint(packageJson.libc, target.libc),
  )
}

function supportsConstraint(values: string[] | undefined, target: string): boolean {
  if (!values?.length) return true
  if (values.length === 1 && values[0] === "any") return true
  if (values.includes(`!${target}`)) return false
  const included = values.filter(value => !value.startsWith("!"))
  return included.length === 0 || included.includes(target)
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
  if ((await stat(serverDir)).isFile()) return [serverDir]
  const entries = await readdir(serverDir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && runtimeExtensions.has(extname(entry.name)))
    .map((entry) => resolve(entry.parentPath, entry.name))
}

async function readRuntimePackages(runtimeDirs: string[], rootDir: string): Promise<RuntimePackage[]> {
  const packages = new Map<string, RuntimePackage>()
  for (const file of (await Promise.all(runtimeDirs.map(runtimeSourceFiles))).flat()) {
    const source = await readFile(file, "utf8")
    for (const [name, packagePath] of collectBundledPackages(source)) {
      const existing = packages.get(name)
      packages.set(name, {
        ...existing,
        hoistOptionalDependencies: true,
        includeOptionalDependencies: true,
        includePeerDependencies: true,
        name,
        onlyIfOptionalDependencies: existing?.onlyIfOptionalDependencies ?? true,
        optional: existing?.optional ?? true,
        packageJsonPath: resolve(isAbsolute(packagePath) ? packagePath : resolve(rootDir, packagePath), "package.json"),
      })
    }
    for (const name of collectImportedPackageNames(source)) {
      packages.set(name, {
        ...packages.get(name),
        includeOptionalDependencies: true,
        includePeerDependencies: true,
        name,
        onlyIfOptionalDependencies: false,
        optional: false,
      })
    }
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function assertSupportedApplicationEntryImports(source: string): void {
  const executableSource = maskInertImportText(source)
  for (const match of executableSource.matchAll(/new URL\(\s*["'](\.[^"']*)["']\s*,\s*import\.meta\.url\s*\)/g)) {
    const specifier = match[1]!
    if (specifier === "./schedule/deno-cron.mjs" || specifier === "./server/index.mjs") continue
    throw new Error(`Deno application entrypoint contains an unsupported computed local import ${JSON.stringify(specifier)}. Use a static import so ViteHub can bundle its dependency.`)
  }
  const remaining = executableSource.replaceAll(/import\s*\(\s*new URL\(\s*["']\.\/(?:schedule\/deno-cron\.mjs|server\/index\.mjs)["']\s*,\s*import\.meta\.url\s*\)\.href\s*\)/g, "")
  if (/\bimport\s*\(\s*[^"'\s]/.test(remaining)) {
    throw new Error("Deno application entrypoint contains an unsupported computed import. Use a static import so ViteHub can bundle its dependency.")
  }
}

function denoDeployRunnerSource(deploymentName: string | undefined, entrypoint: string): string {
  return `import { spawn } from "node:child_process"
import { access, cp, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const organization = process.env.DENO_DEPLOY_ORG
const app = process.env.DENO_DEPLOY_APP || ${JSON.stringify(deploymentName)}
const region = process.env.DENO_DEPLOY_REGION || "global"
const entrypoint = ${JSON.stringify(entrypoint)}

if (!organization || !app) {
  throw new Error("DENO_DEPLOY_ORG and DENO_DEPLOY_APP are required.")
}

let activeChild

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("deno", args, { cwd, stdio: "inherit" })
    activeChild = child
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      activeChild = undefined
      resolve({ code, signal })
    })
  })
}

async function enclosingGitRoot(path) {
  let current = resolve(path)
  while (true) {
    try {
      await access(join(current, ".git"))
      return current
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

function contains(parent, child) {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

const sourceRoot = await realpath(fileURLToPath(new URL(".", import.meta.url)))
const uploadRoot = await realpath(await mkdtemp(join(tmpdir(), "vitehub-deno-deploy-")))
const signals = ["SIGINT", "SIGTERM"]
const handleSignal = (signal) => {
  activeChild?.kill(signal)
  void rm(uploadRoot, { force: true, recursive: true }).finally(() => {
    process.kill(process.pid, signal)
  })
}
for (const signal of signals) process.once(signal, handleSignal)

try {
  if (contains(sourceRoot, uploadRoot) || await enclosingGitRoot(uploadRoot)) {
    throw new Error("Deno deployment staging must be outside the generated output and any enclosing Git repository. Set TMPDIR to an external directory.")
  }
  await cp(sourceRoot, uploadRoot, { recursive: true })

  const common = ["--allow-node-modules", "--org", organization, "--app", app]
  const creation = await run(["deploy", "create", ".", "--source", "local", "--do-not-use-detected-build-config", "--runtime-mode", "dynamic", "--entrypoint", entrypoint, "--working-directory", ".", "--region", region, ...common], uploadRoot)
  if (creation.code !== 0) {
    const deployment = await run(["deploy", ".", "--prod", "--config", "deno.json", ...common], uploadRoot)
    if (deployment.code !== 0) {
      throw new Error("deno deploy exited with " + (deployment.signal || "code " + deployment.code))
    }
  }
} finally {
  for (const signal of signals) process.off(signal, handleSignal)
  await rm(uploadRoot, { force: true, recursive: true })
}
`
}

export async function finalizeDenoDeploymentOutput(
  options: FinalizeDenoDeploymentOutputOptions,
): Promise<void> {
  const outputDir = resolve(options.rootDir, options.outputDir ?? ".output")
  const serverDir = join(outputDir, "server")
  const scheduleSource = join(options.rootDir, ".vitehub", "schedule", "deno-cron.mjs")
  const applicationEntrySource = join(options.rootDir, "main.ts")
  let entrypoint = "server/index.mjs"
  let hasSchedule = false
  try {
    await access(scheduleSource)
    if (options.hasScheduleIntegration === false) {
      await rm(scheduleSource, { force: true })
      throw Object.assign(new Error("stale Deno Schedule output"), { code: "ENOENT" })
    }
    hasSchedule = true
    await access(applicationEntrySource)
    if (options.hasCustomAliasResolver) {
      throw new Error("[vitehub] Deno Schedule output cannot stage Vite aliases with customResolver. Use a string or RegExp alias with a string replacement.")
    }
    await mkdir(join(outputDir, "schedule"), { recursive: true })
    await bundleEsmEntry(scheduleSource, join(outputDir, "schedule", "deno-cron.mjs"), {
      external: [...builtinModuleNames],
      alias: options.alias,
      format: "esm",
      packages: "external",
      platform: "neutral",
      rootDir: options.rootDir,
      workingDir: options.rootDir,
    })
    const applicationOutput = join(outputDir, "main.ts")
    const temporaryApplicationOutput = `${applicationOutput}.vitehub-tmp`
    try {
      await bundleEsmEntry(applicationEntrySource, temporaryApplicationOutput, {
        external: [...builtinModuleNames, "./schedule/*", "./server/*"],
        alias: options.alias,
        format: "esm",
        packages: "external",
        platform: "neutral",
        rootDir: options.rootDir,
        workingDir: options.rootDir,
      })
      assertSupportedApplicationEntryImports(await readFile(temporaryApplicationOutput, "utf8"))
      await rename(temporaryApplicationOutput, applicationOutput)
    }
    finally {
      await rm(temporaryApplicationOutput, { force: true })
    }
    entrypoint = "main.ts"
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    if (hasSchedule) {
      throw new Error('Deno Schedule output requires a project-root "main.ts" application entrypoint.', { cause: error })
    }
  }
  const packages = await readRuntimePackages([
    serverDir,
    ...(hasSchedule ? [join(outputDir, "schedule"), join(outputDir, "main.ts")] : []),
  ], options.rootDir)

  await copyRuntimePackagesToNodeModules({
    outputNodeModules: join(outputDir, "node_modules"),
    packages,
    rootDir: options.rootDir,
  })

  const denoConfig = {
    deploy: {
      runtime: {
        type: "dynamic",
        entrypoint: `./${entrypoint}`,
        cwd: ".",
      },
    },
    nodeModulesDir: "manual",
    tasks: { start: `deno run ${hasSchedule ? "--unstable-cron " : ""}-A ./${entrypoint}` },
  }
  // Existing apps may retain this entrypoint; keep its import opaque to Deno's type checker.
  await writeFile(
    join(serverDir, "index.ts"),
    'await import("./index." + "mjs")\n',
    "utf8",
  )
  await writeFile(join(outputDir, "deno.json"), `${JSON.stringify(denoConfig, null, 2)}\n`, "utf8")
  await writeFile(join(outputDir, "deploy.mjs"), denoDeployRunnerSource(options.deploymentName, entrypoint), "utf8")
}
