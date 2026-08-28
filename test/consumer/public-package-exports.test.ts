import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"
import ts from "typescript"
import { array, boolean, object, optional, parse, record, string } from "valibot"

import { publicPackageBinContracts, publicPackageExportContracts } from "../public-package-exports"
import { packageInfos } from "../utils/repo"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "../..")
const maxBuffer = 64 * 1024 * 1024

function isJavaScriptModule(target: string) {
  return target.endsWith(".js") || target.endsWith(".mjs")
}

function usesNodeDeclarationTypes(contract: (typeof publicPackageExportContracts)[number]) {
  if (contract.packageName === "@vite-hub/auth") return false
  return !contract.subpath.endsWith("/client")
}

const stringRecord = record(string(), string())
const packageManifestSchema = object({
  dependencies: optional(stringRecord),
  devDependencies: optional(stringRecord),
  name: optional(string()),
  optionalDependencies: optional(stringRecord),
  peerDependencies: optional(stringRecord),
  peerDependenciesMeta: optional(record(string(), object({ optional: optional(boolean()) }))),
  version: optional(string()),
})

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
    "@types/json-schema": await installedVersion(join(repoRoot, "packages/agent/node_modules/@types/json-schema/package.json")),
    "@types/mdast": await installedVersion(join(repoRoot, "packages/agent/node_modules/@types/mdast/package.json")),
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

async function importSpecifiers(appDir: string, specifiers: readonly string[], withCloudflareHost = false) {
  for (const specifier of specifiers) {
    const script = [
      ...(withCloudflareHost
        ? [
            'const { registerHooks } = await import("node:module")',
            "registerHooks({ resolve(specifier, context, nextResolve) {",
            '  if (specifier === "cloudflare:workers") return { shortCircuit: true, url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }" }',
            "  return nextResolve(specifier, context)",
            "} })",
          ]
        : []),
      "await import(process.argv[1])",
    ].join("\n")
    await run(process.execPath, ["--input-type=module", "--eval", script, specifier], appDir)
  }
}

async function importPackagesWithoutRootFallback(
  appDir: string,
  includeOptionalPeers: boolean,
  includePackage: (packageName: string) => boolean = () => true,
) {
  const includedPackages = packageInfos.filter(info => includePackage(info.packageName))
  const packageRoots = new Map(await Promise.all(includedPackages.map(async info => [
    info.packageName,
    await realpath(join(appDir, "node_modules", ...info.packageName.split("/"))),
  ] as const)))

  for (const info of includedPackages) {
    const packageRoot = packageRoots.get(info.packageName)
    if (!packageRoot) throw new Error(`Missing installed package root for ${info.packageName}`)
    const manifest = await readManifest(join(packageRoot, "package.json"))
    const requiredPeers = Object.keys(manifest.peerDependencies || {}).filter(name =>
      !manifest.peerDependenciesMeta?.[name]?.optional,
    )
    await withoutRootDependencies(appDir, new Set([
      info.packageName,
      ...(info.packageName === "@vite-hub/auth" ? [] : ["@types/node"]),
      ...requiredPeers,
      ...(includeOptionalPeers ? Object.keys(manifest.peerDependencies || {}) : []),
    ]), async () => {
      const runnerDir = join(appDir, ".isolated", info.name)
      const packageNameParts = info.packageName.split("/")
      const linkDir = join(runnerDir, "node_modules", ...packageNameParts.slice(0, -1))
      await rm(runnerDir, { recursive: true, force: true })
      await mkdir(linkDir, { recursive: true })
      const packageDirName = packageNameParts.at(-1)
      if (!packageDirName) throw new Error(`Invalid package name: ${info.packageName}`)
      await symlink(packageRoot, join(linkDir, packageDirName), "dir")
      const importableContracts = publicPackageExportContracts
        .filter(contract => contract.packageName === info.packageName
          && isJavaScriptModule(contract.target)
          && (includeOptionalPeers || contract.optionalRuntimePeers.length === 0))
      const cloudflareContracts = importableContracts.filter(contract => contract.specifier.endsWith("/cloudflare/state"))
      await importSpecifiers(runnerDir, importableContracts
        .filter(contract => !cloudflareContracts.includes(contract))
        .map(contract => contract.specifier))
      await importSpecifiers(runnerDir, cloudflareContracts.map(contract => contract.specifier), true)
      await typecheckPackageExports(info.packageName, packageRoot, runnerDir, includeOptionalPeers)
    })
  }
}

async function exercisePackagesWithoutOptionalPeers(root: string, specs: Record<string, string>) {
  const requiredPeerSpecs: Record<string, string> = {
    ai: await installedVersion(join(repoRoot, "packages/ui/node_modules/ai/package.json")),
    "@types/json-schema": await installedVersion(join(repoRoot, "packages/agent/node_modules/@types/json-schema/package.json")),
    "@types/mdast": await installedVersion(join(repoRoot, "packages/agent/node_modules/@types/mdast/package.json")),
    "@types/node": await installedVersion(join(repoRoot, "node_modules/@types/node/package.json")),
    "drizzle-kit": await installedVersion(join(repoRoot, "packages/database/node_modules/drizzle-kit/package.json")),
    "drizzle-orm": await installedVersion(join(repoRoot, "packages/database/node_modules/drizzle-orm/package.json")),
    vite: requiredDependency(await readManifest(join(repoRoot, "fixtures/consumer/vite-hub/package.json")), "vite"),
    vue: await installedVersion(join(repoRoot, "packages/agent/node_modules/vue/package.json")),
  }

  for (const info of packageInfos) {
    const appDir = join(root, "absent-peers", info.name)
    const sourceManifest = await readManifest(join(repoRoot, "packages", info.name, "package.json"))
    const requiredPeers = Object.keys(sourceManifest.peerDependencies || {}).filter(name =>
      !sourceManifest.peerDependenciesMeta?.[name]?.optional,
    )
    await mkdir(appDir, { recursive: true })
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
        dependencies: { [info.packageName]: specs[info.packageName] },
        devDependencies: Object.fromEntries([
          ...(info.packageName === "@vite-hub/auth" ? [] : ["@types/node"]),
          ...requiredPeers,
        ].map(name => {
          const spec = specs[name] || requiredPeerSpecs[name]
          if (!spec) throw new Error(`Missing required peer spec for ${name}`)
          return [name, spec]
        })),
        packageManager: "pnpm@10.33.0",
        private: true,
        type: "module",
      }, null, 2), "utf8"),
      writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs), "utf8"),
    ])
    await run("corepack", ["pnpm", "install", "--ignore-scripts"], appDir)
    await importPackagesWithoutRootFallback(appDir, false, packageName => packageName === info.packageName)
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

async function typecheckPackageExports(packageName: string, packageRoot: string, runnerDir: string, includeOptionalPeers: boolean) {
  const modules = publicPackageExportContracts.filter(contract =>
    contract.packageName === packageName
    && isJavaScriptModule(contract.target)
    && (includeOptionalPeers || contract.optionalDeclarationPeers.length === 0),
  )
  for (const [index, contract] of modules.entries()) {
    await typecheckPackageModule(
      packageName,
      packageRoot,
      runnerDir,
      contract,
      index,
      contract.specifier.endsWith("/cloudflare/state"),
    )
  }
}

async function typecheckPackageModule(
  packageName: string,
  packageRoot: string,
  runnerDir: string,
  contract: (typeof publicPackageExportContracts)[number],
  index: number,
  withCloudflareHost: boolean,
) {
  const ambientModules: Record<string, readonly string[]> = {
    "@vite-hub/blob": ["#vitehub/blob/config"],
    "@vite-hub/database": ["#vitehub/database/schema", "#vitehub/database/databases", "#vitehub/database/definition-defaults"],
    "@vite-hub/env": ["#vitehub/env/public", "#vitehub/env/server"],
    "@vite-hub/kv": ["#vitehub/kv/config"],
  }
  const ambientModuleSpecifiers = contract.specifier === `${packageName}/virtual`
    ? ambientModules[packageName] || []
    : []
  const source = [
    `import type * as PackageExport from ${JSON.stringify(contract.specifier)}`,
    "declare const packageExport: typeof PackageExport",
    "void packageExport",
    ...ambientModuleSpecifiers.map((specifier, ambientIndex) => [
      `import type * as AmbientModule${ambientIndex} from ${JSON.stringify(specifier)}`,
      `void (undefined as unknown as typeof AmbientModule${ambientIndex})`,
    ].join("\n")),
  ].join("\n")
  const sourcePath = join(runnerDir, `export-${index}.ts`)
  await writeFile(sourcePath, `${source}\n`, "utf8")
  const rootNames = [sourcePath]
  let hostTypesPath: string | undefined
  if (withCloudflareHost) {
    hostTypesPath = join(runnerDir, "cloudflare-workers.d.ts")
    await writeFile(hostTypesPath, [
      "export class DurableObject<Env = unknown> {",
      "  protected ctx: unknown",
      "  protected env: Env",
      "  constructor(ctx: unknown, env: Env)",
      "}",
      "",
    ].join("\n"), "utf8")
    rootNames.push(hostTypesPath)
  }
  const paths: ts.CompilerOptions["paths"] = {}
  if (hostTypesPath) {
    paths["cloudflare:workers"] = [hostTypesPath]
  }
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    paths,
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    types: usesNodeDeclarationTypes(contract) ? ["node"] : [],
  }
  const program = ts.createProgram(rootNames, options)
  const diagnostics = ts.getPreEmitDiagnostics(program)
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
  it("imports runtime contracts in isolated processes", async () => {
    const guardedModule = (id: number) => `data:text/javascript,${encodeURIComponent([
      "if (globalThis.__vitehubPublicExportLoaded) throw new Error('shared process')",
      "globalThis.__vitehubPublicExportLoaded = true",
      `export const id = ${id}`,
    ].join("\n"))}`

    await importSpecifiers(tmpdir(), [guardedModule(1), guardedModule(2)])
  })

  it("forwards non-Cloudflare imports through the host shim", async () => {
    await importSpecifiers(tmpdir(), ["node:path"], true)
  })

  it("reports diagnostics reached through dependency declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-declaration-diagnostics-"))
    const dependencyDir = join(root, "node_modules/dependency")
    const typesDir = join(root, "node_modules/@types/example")
    const sourcePath = join(root, "consumer.ts")

    try {
      await Promise.all([
        mkdir(dependencyDir, { recursive: true }),
        mkdir(typesDir, { recursive: true }),
      ])
      await Promise.all([
        writeFile(join(dependencyDir, "package.json"), JSON.stringify({ name: "dependency", types: "index.d.ts" })),
        writeFile(join(dependencyDir, "index.d.ts"), "export type BrokenDependency = MissingDependency\n"),
        writeFile(join(typesDir, "package.json"), JSON.stringify({ name: "@types/example", types: "index.d.ts" })),
        writeFile(join(typesDir, "index.d.ts"), "export type BrokenTypes = MissingTypes\n"),
        writeFile(sourcePath, 'import type { BrokenDependency } from "dependency"\nimport type { BrokenTypes } from "example"\nvoid (undefined as unknown as BrokenDependency | BrokenTypes)\n'),
      ])

      const program = ts.createProgram([sourcePath], {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: false,
      })
      const diagnosticFiles = ts.getPreEmitDiagnostics(program)
        .filter(diagnostic => diagnostic.code === 2304)
        .map(diagnostic => diagnostic.file?.fileName)

      expect(diagnosticFiles).toEqual(expect.arrayContaining([
        join(dependencyDir, "index.d.ts"),
        join(typesDir, "index.d.ts"),
      ]))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
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

      const optionalPeers = ["@nuxt/ui", "@upstash/redis", "comark-content", "evalite", "openworkflow", "playwright-core", "vite", "vitest", "vue"]
      await assertResolution(appDir, optionalPeers, false)
      await exercisePackagesWithoutOptionalPeers(root, specs)

      expect(await addOptionalPeers(appDir)).toEqual(optionalPeers)
      await assertResolution(appDir, optionalPeers, true)
      const presentPeerContracts = publicPackageExportContracts
        .filter(contract => isJavaScriptModule(contract.target))
      const presentCloudflareContracts = presentPeerContracts.filter(contract => contract.specifier.endsWith("/cloudflare/state"))
      await importSpecifiers(appDir, presentPeerContracts
        .filter(contract => !presentCloudflareContracts.includes(contract))
        .map(contract => contract.specifier))
      await importSpecifiers(appDir, presentCloudflareContracts.map(contract => contract.specifier), true)
      await importPackagesWithoutRootFallback(appDir, true)
      const staticContracts = publicPackageExportContracts.filter(contract => contract.kind === "static-asset")
      const resolved = await resolveSpecifiers(appDir, staticContracts.map(contract => contract.specifier))
      for (const [index, url] of resolved.entries()) {
        const contract = staticContracts[index]!
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
