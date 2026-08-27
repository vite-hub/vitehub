import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"
import ts from "typescript"
import { array, object, optional, parse, record, string } from "valibot"

import { publicPackageBinContracts, publicPackageExportContracts } from "../public-package-exports"
import { packageInfos } from "../utils/repo"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "../..")
const maxBuffer = 64 * 1024 * 1024

function isJavaScriptModule(target: string) {
  return target.endsWith(".js") || target.endsWith(".mjs")
}

const stringRecord = record(string(), string())
const packageManifestSchema = object({
  dependencies: optional(stringRecord),
  devDependencies: optional(stringRecord),
  name: optional(string()),
  optionalDependencies: optional(stringRecord),
  peerDependencies: optional(stringRecord),
  version: optional(string()),
})

function isPackageDiagnostic(diagnostic: ts.Diagnostic, sourcePath: string, packageRoot: string) {
  return !diagnostic.file
    || diagnostic.file.fileName === sourcePath
    || diagnostic.file.fileName.startsWith(`${packageRoot}${sep}`)
}

async function run(command: string, args: string[], cwd: string) {
  try {
    const result = await execFileAsync(command, args, { cwd, maxBuffer })
    return { stderr: String(result.stderr || ""), stdout: String(result.stdout || "") }
  }
  catch (error) {
    // SAFETY: execFile attaches captured stdout and stderr to its rejected Error.
    const failed = error as Error & { stderr?: string | Buffer, stdout?: string | Buffer }
    const output = `${failed.stdout || ""}${failed.stderr || ""}`
    throw new Error(`${command} ${args.join(" ")} failed${output ? `\n${output}` : ""}`, { cause: error })
  }
}

function workspaceConfig(specs: Record<string, string>) {
  const overrides = Object.entries(specs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`)
  return ["packages:", "  - .", "overrides:", ...overrides, ""].join("\n")
}

async function readManifest(path: string) {
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  return parse(packageManifestSchema, value)
}

async function installedVersion(path: string) {
  const version = (await readManifest(path)).version
  if (!version) throw new Error(`${path} must declare a version`)
  return version
}

function requiredDependency(manifest: { dependencies?: Record<string, string> }, name: string) {
  const version = manifest.dependencies?.[name]
  if (!version) throw new Error(`Consumer fixture must declare ${name}`)
  return version
}

async function packPublicPackages(packDir: string) {
  const specs: Record<string, string> = {}
  for (const info of packageInfos) {
    const before = new Set(await readdir(packDir))
    await run("corepack", ["pnpm", "--filter", info.packageName, "pack", "--pack-destination", packDir], repoRoot)
    const tarballs = (await readdir(packDir)).filter(file => !before.has(file))
    expect(tarballs, `${info.packageName} should produce one tarball`).toHaveLength(1)
    specs[info.packageName] = `file:${join(packDir, tarballs[0]!)}`
  }
  return specs
}

async function writeConsumer(appDir: string, specs: Record<string, string>) {
  const requiredPeers = {
    ai: await installedVersion(join(repoRoot, "packages/ui/node_modules/ai/package.json")),
    "@types/node": await installedVersion(join(repoRoot, "node_modules/@types/node/package.json")),
    "drizzle-kit": await installedVersion(join(repoRoot, "packages/database/node_modules/drizzle-kit/package.json")),
    "drizzle-orm": await installedVersion(join(repoRoot, "packages/database/node_modules/drizzle-orm/package.json")),
    typescript: await installedVersion(join(repoRoot, "node_modules/typescript/package.json")),
  }

  await Promise.all([
    writeFile(join(appDir, ".npmrc"), [
      "auto-install-peers=false",
      "hoist=false",
      "node-linker=isolated",
      "public-hoist-pattern[]=",
      "shamefully-hoist=false",
      "strict-peer-dependencies=false",
      "",
    ].join("\n"), "utf8"),
    writeFile(join(appDir, "package.json"), JSON.stringify({
      dependencies: specs,
      devDependencies: requiredPeers,
      packageManager: "pnpm@10.33.0",
      private: true,
      type: "module",
    }, null, 2), "utf8"),
    writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs), "utf8"),
  ])
}

async function resolveSpecifiers(appDir: string, specifiers: readonly string[]) {
  const script = [
    "const specifiers = JSON.parse(process.argv[1])",
    "process.stdout.write(JSON.stringify(specifiers.map(specifier => import.meta.resolve(specifier))))",
  ].join("\n")
  const { stdout } = await run(process.execPath, ["--input-type=module", "--eval", script, JSON.stringify(specifiers)], appDir)
  const value: unknown = JSON.parse(stdout)
  return parse(array(string()), value)
}

async function importSpecifiers(appDir: string, specifiers: readonly string[]) {
  const script = [
    "const specifiers = JSON.parse(process.argv[1])",
    "const failures = []",
    "for (const specifier of specifiers) {",
    "  try { await import(specifier) }",
    "  catch (error) { failures.push({ message: error instanceof Error ? error.message : String(error), specifier }) }",
    "}",
    "if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exitCode = 1 }",
  ].join("\n")
  await run(process.execPath, ["--input-type=module", "--eval", script, JSON.stringify(specifiers)], appDir)
}

async function importPackagesWithoutRootFallback(appDir: string) {
  const packageRoots = new Map(await Promise.all(packageInfos.map(async info => [
    info.packageName,
    await realpath(join(appDir, "node_modules", ...info.packageName.split("/"))),
  ] as const)))

  for (const info of packageInfos) {
    const packageRoot = packageRoots.get(info.packageName)
    if (!packageRoot) throw new Error(`Missing installed package root for ${info.packageName}`)
    const manifest = await readManifest(join(packageRoot, "package.json"))
    await withoutRootDependencies(appDir, new Set([
      info.packageName,
      "@types/node",
      ...Object.keys(manifest.peerDependencies || {}),
    ]), async () => {
      const runnerDir = join(appDir, ".isolated", info.name)
      const packageNameParts = info.packageName.split("/")
      const linkDir = join(runnerDir, "node_modules", ...packageNameParts.slice(0, -1))
      await mkdir(linkDir, { recursive: true })
      const packageDirName = packageNameParts.at(-1)
      if (!packageDirName) throw new Error(`Invalid package name: ${info.packageName}`)
      await symlink(packageRoot, join(linkDir, packageDirName), "dir")
      await importSpecifiers(runnerDir, publicPackageExportContracts
        .filter(contract => contract.packageName === info.packageName && isJavaScriptModule(contract.target) && contract.kind !== "type-only")
        .map(contract => contract.specifier))
      await typecheckPackageExports(info.packageName, packageRoot, runnerDir)
    })
  }
}

async function withoutRootDependencies(appDir: string, allowed: Set<string>, runIsolated: () => Promise<void>) {
  const manifest = await readManifest(join(appDir, "package.json"))
  const rootDependencies = [...new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
  ])].filter(name => !allowed.has(name))
  const hiddenRoot = join(appDir, ".root-dependencies")
  const moved: string[] = []

  try {
    for (const name of rootDependencies) {
      const parts = name.split("/")
      const destination = join(hiddenRoot, ...parts)
      await mkdir(dirname(destination), { recursive: true })
      await rename(join(appDir, "node_modules", ...parts), destination)
      moved.push(name)
    }
    await runIsolated()
  }
  finally {
    for (const name of moved.reverse()) {
      const parts = name.split("/")
      await rename(join(hiddenRoot, ...parts), join(appDir, "node_modules", ...parts))
    }
    await rm(hiddenRoot, { recursive: true, force: true })
  }
}

async function assertResolution(appDir: string, specifiers: readonly string[], expected: boolean) {
  const script = [
    "const specifiers = JSON.parse(process.argv[1])",
    "const resolved = specifiers.map(specifier => {",
    "  try { import.meta.resolve(specifier); return true } catch { return false }",
    "})",
    "process.stdout.write(JSON.stringify(resolved))",
  ].join("\n")
  const { stdout } = await run(process.execPath, ["--input-type=module", "--eval", script, JSON.stringify(specifiers)], appDir)
  expect(JSON.parse(stdout)).toEqual(specifiers.map(() => expected))
}

async function addOptionalPeers(appDir: string) {
  const agentManifest = await readManifest(join(appDir, "node_modules/@vite-hub/agent/package.json"))
  const peers = {
    "@nuxt/ui": await installedVersion(join(repoRoot, "packages/ui/node_modules/@nuxt/ui/package.json")),
    "@upstash/redis": await installedVersion(join(repoRoot, "packages/kv/node_modules/@upstash/redis/package.json")),
    "comark-content": await installedVersion(join(repoRoot, "packages/source/node_modules/comark-content/package.json")),
    evalite: await installedVersion(join(repoRoot, "packages/agent/node_modules/evalite/package.json")),
    "files-sdk": await installedVersion(join(repoRoot, "packages/blob/node_modules/files-sdk/package.json")),
    openworkflow: await installedVersion(join(repoRoot, "packages/workflow/node_modules/openworkflow/package.json")),
    "playwright-core": await installedVersion(join(repoRoot, "packages/browser/node_modules/playwright-core/package.json")),
    vite: requiredDependency(await readManifest(join(repoRoot, "fixtures/consumer/vite-hub/package.json")), "vite"),
    vitest: agentManifest.peerDependencies!.vitest!,
    vue: await installedVersion(join(repoRoot, "packages/agent/node_modules/vue/package.json")),
  }
  const args = Object.entries(peers).map(([name, version]) => `${name}@${version}`)
  await run("corepack", ["pnpm", "add", "--save-dev", "--ignore-scripts", ...args], appDir)
  return Object.keys(peers)
}

async function withRequiredVue(appDir: string, runWithVue: () => Promise<void>) {
  const version = await installedVersion(join(repoRoot, "packages/agent/node_modules/vue/package.json"))
  await run("corepack", ["pnpm", "add", "--save-dev", "--ignore-scripts", `vue@${version}`], appDir)
  try {
    await runWithVue()
  }
  finally {
    await run("corepack", ["pnpm", "remove", "vue"], appDir)
  }
}

async function typecheckPackageExports(packageName: string, packageRoot: string, runnerDir: string) {
  const modules = publicPackageExportContracts.filter(contract =>
    contract.packageName === packageName && isJavaScriptModule(contract.target),
  )
  const ambientModules: Record<string, string> = {
    "@vite-hub/blob": "#vitehub/blob/config",
    "@vite-hub/kv": "#vitehub/kv/config",
  }
  const ambientModule = ambientModules[packageName]
  const source = [
    ...modules.map((contract, index) => [
      `import type * as Export${index} from ${JSON.stringify(contract.specifier)}`,
      `type Contract${index} = typeof Export${index}`,
      `declare const contract${index}: Contract${index}`,
      `void contract${index}`,
    ].join("\n")),
    ...(ambientModule ? [`import type * as AmbientModule from ${JSON.stringify(ambientModule)}`, "void (undefined as unknown as typeof AmbientModule)"] : []),
  ].join("\n")
  await writeFile(join(runnerDir, "exports.ts"), `${source}\n`, "utf8")
  const sourcePath = join(runnerDir, "exports.ts")
  const rootNames = [sourcePath]
  if (packageName === "@vite-hub/agent") {
    const hostTypesPath = join(runnerDir, "cloudflare-workers.d.ts")
    await writeFile(hostTypesPath, [
      "declare module \"cloudflare:workers\" {",
      "  export class DurableObject<Env = unknown> {",
      "    protected ctx: unknown",
      "    protected env: Env",
      "    constructor(ctx: unknown, env: Env)",
      "  }",
      "}",
      "",
    ].join("\n"), "utf8")
    rootNames.push(hostTypesPath)
  }
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    types: ["node"],
  }
  const program = ts.createProgram(rootNames, options)
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic =>
    isPackageDiagnostic(diagnostic, sourcePath, packageRoot),
  )
  expect(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => runnerDir,
      getNewLine: () => "\n",
    }),
    `${packageName} should expose valid declarations with its own dependency closure`,
  ).toBe("")
}

describe("published declaration diagnostics", () => {
  it("keeps diagnostics without an associated file", () => {
    const diagnostic: ts.Diagnostic = {
      category: ts.DiagnosticCategory.Error,
      code: 2688,
      messageText: "Cannot find type definition file for 'missing-types'.",
    }

    expect(isPackageDiagnostic(diagnostic, "/consumer/exports.ts", "/consumer/node_modules/example")).toBe(true)
  })
})

describe.skipIf(process.env.VITEHUB_CONSUMER_CONTRACT !== "1")("public package exports from tarballs", () => {
  it("installs and exercises every classified export without workspace visibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-public-exports-"))
    const appDir = join(root, "consumer")
    const packDir = join(root, "packs")

    try {
      await Promise.all([mkdir(appDir, { recursive: true }), mkdir(packDir, { recursive: true })])
      const specs = await packPublicPackages(packDir)
      await writeConsumer(appDir, specs)
      await run("corepack", ["pnpm", "install", "--ignore-scripts"], appDir)

      const consumerRoot = await realpath(appDir)
      for (const info of packageInfos) {
        const packageRoot = await realpath(join(appDir, "node_modules", ...info.packageName.split("/")))
        const fromConsumer = relative(consumerRoot, packageRoot)
        expect(fromConsumer === ".." || fromConsumer.startsWith(`..${sep}`), `${info.packageName} should stay inside the consumer`).toBe(false)
        expect(packageRoot, `${info.packageName} should not resolve to a workspace package`).not.toContain(`${sep}packages${sep}${info.name}`)

        const manifest = await readManifest(join(packageRoot, "package.json"))
        for (const section of [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
          for (const spec of Object.values(section || {})) {
            expect(spec, `${info.packageName} should not publish a workspace-only dependency`).not.toMatch(/^(?:catalog|workspace):/)
          }
        }
      }

      const optionalPeers = ["@nuxt/ui", "@upstash/redis", "comark-content", "evalite", "files-sdk", "openworkflow", "playwright-core", "vite", "vitest", "vue"]
      await withRequiredVue(appDir, async () => {
        await importSpecifiers(appDir, publicPackageExportContracts
          .filter(contract => contract.packageName === "@vite-hub/ui" && isJavaScriptModule(contract.target) && contract.kind !== "type-only" && contract.optionalPeers.length === 0)
          .map(contract => contract.specifier))
      })
      await assertResolution(appDir, optionalPeers, false)
      await importSpecifiers(appDir, publicPackageExportContracts
        .filter(contract => contract.packageName !== "@vite-hub/ui" && isJavaScriptModule(contract.target) && contract.kind !== "type-only" && contract.optionalPeers.length === 0)
        .map(contract => contract.specifier))

      expect(await addOptionalPeers(appDir)).toEqual(optionalPeers)
      await assertResolution(appDir, optionalPeers, true)
      await importSpecifiers(appDir, publicPackageExportContracts
        .filter(contract => isJavaScriptModule(contract.target) && contract.kind !== "type-only")
        .map(contract => contract.specifier))
      await importPackagesWithoutRootFallback(appDir)
      const staticContracts = publicPackageExportContracts.filter(contract => contract.kind === "static-asset")
      const typeOnlyContracts = publicPackageExportContracts.filter(contract => contract.kind === "type-only")
      const resolved = await resolveSpecifiers(appDir, [...staticContracts, ...typeOnlyContracts].map(contract => contract.specifier))
      for (const [index, url] of resolved.entries()) {
        const contract = [...staticContracts, ...typeOnlyContracts][index]!
        const path = fileURLToPath(url)
        expect(existsSync(path), `${contract.specifier} should resolve from the installed package`).toBe(true)
        expect((await readFile(path)).byteLength, `${contract.specifier} should not publish an empty asset`).toBeGreaterThan(0)
      }

      for (const contract of publicPackageBinContracts) {
        const packageRoot = await realpath(join(appDir, "node_modules", ...contract.packageName.split("/")))
        const result = await run(process.execPath, [join(packageRoot, contract.target), "--help"], appDir)
        expect(result.stdout, `${contract.packageName} ${contract.binName} should print help`).toContain("Usage: vitehub")
        expect(result.stderr).toBe("")
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)
})
