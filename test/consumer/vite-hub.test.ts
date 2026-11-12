import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join, posix, relative, resolve } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { filesSdkDriverPeers } from "../../packages/blob/src/internal/files-sdk-peers.ts"
import { packedWorkspacePackages } from "../../packages/internal/test-utils/published-types.ts"
import { listWorkspacePackageInfos } from "../../packages/internal/src/workspace-inventory.ts"
import { readReleaseArtifactTarballs, resolveReleaseArtifactTarball } from "../utils/release-artifacts"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "../..")
const fixtureRoot = resolve(repoRoot, "fixtures/consumer/vite-hub")
const maxBuffer = 64 * 1024 * 1024
const optionalPackages = [
  "@agntn/web",
  "@ai-sdk/mcp",
  "@chat-adapter/discord",
  "@cloudflare/sandbox",
  "@vercel/blob",
  "@vercel/queue",
  "@vercel/sandbox",
  "evalite",
  "files-sdk",
  "openworkflow",
  "vitest",
]
const storageSdkPackages = [...new Set(Object.values(filesSdkDriverPeers).flat())]
// The consumer fixture enables these opt-in features, so it installs their owner packages next to `vite-hub`.
const fixtureViteHubPackages = [
  "@vite-hub/agent",
  "@vite-hub/auth",
  "@vite-hub/blob",
  "@vite-hub/database",
  "@vite-hub/email",
  "@vite-hub/markdown-template",
  "@vite-hub/queue",
  "@vite-hub/rate-limit",
  "@vite-hub/sandbox",
  "@vite-hub/schedule",
  "@vite-hub/workflow",
  "@vite-hub/workspace",
  "vite-hub",
]

interface PackageManifest {
  bin?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  exports?: Record<string, string | Record<string, string>>
  name: string
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  types?: string
  version: string
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  console.log(`[consumer] ${command} ${args.join(" ")}`)
  if (command === "pnpm") {
    command = "corepack"
    args = ["pnpm", ...args]
  }
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env,
      maxBuffer,
    })
    return {
      stderr: String(result.stderr || ""),
      stdout: String(result.stdout || ""),
    }
  }
  catch (error) {
    const failed = error as Error & { stderr?: string | Buffer, stdout?: string | Buffer }
    const output = `${failed.stdout || ""}${failed.stderr || ""}`
    throw new Error(`${command} ${args.join(" ")} failed${output ? `\n${output}` : ""}`, { cause: error })
  }
}

async function availablePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : undefined
  server.close()
  await once(server, "close")
  if (!port) throw new Error("Failed to reserve a consumer test port.")
  return port
}

async function withNodeServer<T>(entry: string, cwd: string, callback: (origin: string) => Promise<T>) {
  const port = await availablePort()
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", chunk => { stdout += String(chunk) })
  child.stderr.on("data", chunk => { stderr += String(chunk) })
  const origin = `http://127.0.0.1:${port}`

  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Consumer server exited early.\n${stdout}${stderr}`)
      let ready = false
      try {
        await fetch(origin)
        ready = true
      }
      catch {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (ready) return { logs: () => ({ stderr, stdout }), value: await callback(origin) }
    }
    throw new Error(`Consumer server did not start.\n${stdout}${stderr}`)
  }
  finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM")
      await once(child, "exit")
    }
  }
}

/** Runs a development server until its log matches `ready`. The server can answer 500 while it still builds. */
async function withDevServer<T>(command: string, args: string[], cwd: string, ready: RegExp, callback: (origin: string) => Promise<T>) {
  const port = await availablePort()
  const child = spawn(command, [...args, "--host", "127.0.0.1", "--port", String(port)], {
    cwd,
    detached: true,
    env: { ...process.env, NUXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let logs = ""
  child.stdout.on("data", chunk => { logs += String(chunk) })
  child.stderr.on("data", chunk => { logs += String(chunk) })

  try {
    for (let attempt = 0; !ready.test(logs); attempt++) {
      if (child.exitCode !== null) throw new Error(`Development server exited early.\n${logs}`)
      if (attempt > 2400) throw new Error(`Development server did not start.\n${logs}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return { logs: () => logs, value: await callback(`http://127.0.0.1:${port}`) }
  }
  finally {
    // The package manager starts the server in a child process, so stop the whole group.
    await stopProcessGroup(child.pid!)
  }
}

/**
 * Stops a process group and waits until all of it is gone. The package manager exits as soon as it gets the signal, but
 * the server can still write files while it stops. A caller that removes the app after the package manager exits then
 * fails with `ENOTEMPTY`.
 */
async function stopProcessGroup(pid: number) {
  signalProcessGroup(pid, "SIGTERM")
  for (let attempt = 0; attempt < 150 && signalProcessGroup(pid, 0); attempt++) {
    if (attempt === 100) signalProcessGroup(pid, "SIGKILL")
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Sends `signal` to a process group. Returns false when no process of the group is left. */
function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal)
    return true
  }
  catch {
    return false
  }
}

function packageTarballName(name: string, version: string) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`
}

function dependencySections(manifest: PackageManifest) {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ].filter((section): section is Record<string, string> => Boolean(section))
}

function exportTargets(value: string | Record<string, string>) {
  return typeof value === "string" ? [value] : Object.values(value)
}

function declarationPath(importer: string, specifier: string, files: Set<string>) {
  const path = posix.normalize(posix.join(posix.dirname(importer), specifier))
  const candidates = [
    path.replace(/\.mjs$/, ".d.mts"),
    path.replace(/\.cjs$/, ".d.cts"),
    path.replace(/\.js$/, ".d.ts"),
    `${path}.d.ts`,
    posix.join(path, "index.d.ts"),
  ]
  return candidates.find(candidate => files.has(candidate))
}

async function assertRootDeclarationsAvoidOptionalPeers(tarball: string, manifest: PackageManifest) {
  const optionalPeers = Object.entries(manifest.peerDependenciesMeta || {})
    .filter(([name, meta]) => name !== "vite" && meta.optional)
    .map(([name]) => name)
  if (!manifest.types || !optionalPeers.length) return

  const { stdout: listing } = await run("tar", ["-tzf", tarball], repoRoot)
  const files = new Set(listing.split("\n").filter(Boolean))
  const pending = [`package/${manifest.types.replace(/^\.\//, "")}`]
  const visited = new Set<string>()
  const imports = new Set<string>()
  const importPattern = /(?:\bfrom\s+|\bimport\s*\(\s*)["']([^"']+)["']/g

  while (pending.length) {
    const file = pending.pop()
    if (!file || visited.has(file)) continue
    visited.add(file)
    if (!/\.d\.(?:c|m)?ts$/.test(file)) continue
    const { stdout: source } = await run("tar", ["-xOf", tarball, file], repoRoot)

    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]
      if (!specifier) continue
      if (specifier.startsWith(".")) {
        const target = declarationPath(file, specifier, files)
        if (target) pending.push(target)
        continue
      }
      imports.add(specifier)
    }
  }

  const leaks = [...imports].filter(specifier =>
    optionalPeers.some(name => specifier === name || specifier.startsWith(`${name}/`)),
  )
  expect(leaks, `${manifest.name} root declarations require optional peers`).toEqual([])
}

async function packedManifest(tarball: string) {
  const { stdout } = await run("tar", ["-xOf", tarball, "package/package.json"], repoRoot)
  return JSON.parse(stdout) as PackageManifest
}

async function assertPackedPackage(tarball: string, framework: boolean) {
  const manifest = await packedManifest(tarball)

  for (const section of dependencySections(manifest)) {
    for (const [name, spec] of Object.entries(section)) {
      expect(spec, `${manifest.name} leaves ${name} on a workspace-only protocol`).not.toMatch(/^(?:catalog|workspace):/)
    }
  }

  await assertRootDeclarationsAvoidOptionalPeers(tarball, manifest)

  if (!framework) return

  for (const name of ["@workflow/builders", "workflow"]) {
    expect(manifest.dependencies).not.toHaveProperty(name)
  }

  for (const [name, spec] of Object.entries(manifest.dependencies || {})) {
    if (name.startsWith("@vite-hub/") && !spec.startsWith("npm:")) {
      expect(spec, `${manifest.name} should pin ${name} to its tested release matrix`).toBe(manifest.version)
    }
  }

  const { stdout } = await run("tar", ["-tzf", tarball], repoRoot)
  const files = new Set(stdout.split("\n").filter(Boolean))
  for (const value of Object.values(manifest.exports || {})) {
    for (const target of exportTargets(value)) {
      expect(files, `${manifest.name} is missing packed export ${target}`).toContain(`package/${target.replace(/^\.\//, "")}`)
    }
  }
  for (const target of Object.values(manifest.bin || {})) {
    expect(files, `${manifest.name} is missing packed binary ${target}`).toContain(`package/${target.replace(/^\.\//, "")}`)
  }
}

async function packWorkspacePackages(packDir: string, packageNames?: Set<string>) {
  if (packageNames) {
    const names = await packedWorkspacePackages(repoRoot, [...packageNames].map(name => name.replace(/^@vite-hub\//, "")))
    packageNames = new Set(names.map(name => name === "vite-hub" ? name : `@vite-hub/${name}`))
  }
  const specs: Record<string, string> = {}
  const infos = listWorkspacePackageInfos(repoRoot)
    .filter(info => !info.private && (!packageNames || packageNames.has(info.packageName)))
  const releaseTarballs = readReleaseArtifactTarballs(repoRoot)

  for (const info of infos) {
    const source = JSON.parse(await readFile(join(info.dir, "package.json"), "utf8")) as PackageManifest
    const tarball = await resolveReleaseArtifactTarball(releaseTarballs, info.packageName, async () => {
      await run("pnpm", ["--filter", info.packageName, "pack", "--pack-destination", packDir], repoRoot)
      return join(packDir, packageTarballName(info.packageName, source.version))
    })
    expect(existsSync(tarball), `Missing tarball for ${info.packageName}`).toBe(true)
    await assertPackedPackage(tarball, info.packageName === "vite-hub")
    specs[info.packageName] = `file:${tarball}`
  }

  if (releaseTarballs && !packageNames) expect(releaseTarballs.size).toBe(infos.length)

  return specs
}

async function usePackedPeerManifests(appDir: string, specs: Record<string, string>) {
  // pnpm 10 can resolve an optional peer's dependency graph from registry metadata
  // even when overrides select a tarball. Keep that graph on the exact release too.
  const manifests = Object.fromEntries(await Promise.all(Object.values(specs).map(async (spec) => {
    const manifest = await packedManifest(spec.slice("file:".length))
    return [`${manifest.name}@${manifest.version}`, manifest]
  })))
  await writeFile(join(appDir, ".pnpmfile.cjs"), [
    `const manifests = ${JSON.stringify(manifests)}`,
    "module.exports = { hooks: { readPackage(manifest) {",
    "  const packed = manifests[`${manifest.name}@${manifest.version}`]",
    "  return packed ? structuredClone(packed) : manifest",
    "} } }",
    "",
  ].join("\n"), "utf8")
}

function workspaceConfig(specs: Record<string, string>, additionalOverrides: Record<string, string> = {}) {
  const overrides = Object.entries({
    ...specs,
    // Fresh resolutions selected 2.0.1 while its tarball returned 404; use the workspace-tested version.
    "mdast-util-gfm-table": "2.0.0",
    // Use the workspace-tested pair: newer msgpackr-extract native tarballs returned 404.
    "msgpackr@^2": "2.1.0",
    "msgpackr-extract": "3.0.4",
    // Match the exact Vue peer published by the workspace packages.
    vue: "3.5.44",
    ...additionalOverrides,
  })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`)

  return [
    "packages:",
    "  - .",
    "allowBuilds:",
    "  esbuild: true",
    "  \"@mongodb-js/zstd\": false",
    "  \"@nestjs/core\": false",
    "  \"@parcel/watcher\": false",
    "  \"@swc/core\": false",
    "  \"better-sqlite3\": false",
    "  \"cbor-extract\": false",
    "  \"core-js-pure\": false",
    "  \"cpu-features\": false",
    "  \"msgpackr-extract\": false",
    "  \"node-liblzma\": false",
    "  \"sharp\": false",
    "  \"ssh2\": false",
    "  \"vue-demi\": false",
    "  \"workerd\": false",
    "blockExoticSubdeps: false",
    "overrides:",
    // Match the workspace-tested runtime and keep its Emnapi peers on compatible 1.x versions.
    "  \"@napi-rs/wasm-runtime\": \"1.2.4\"",
    "  \"@emnapi/core\": \"1.9.2\"",
    "  \"@emnapi/runtime\": \"1.9.2\"",
    // Keep Workflow's broad Nest peer pair on the same major in isolated installs.
    "  \"@nestjs/common\": \"11.2.3\"",
    "  \"@nestjs/core\": \"11.2.3\"",
    ...overrides,
    "",
  ].join("\n")
}

function isViteHubPackage(name: string) {
  return name === "vite-hub" || name.startsWith("@vite-hub/")
}

async function assertOnlyViteHubDependencies(appDir: string, expected: string[]) {
  const manifest = JSON.parse(await readFile(join(appDir, "package.json"), "utf8")) as PackageManifest
  const directViteHubPackages = dependencySections(manifest)
    .flatMap(section => Object.keys(section))
    .filter(isViteHubPackage)
    .sort()

  expect(directViteHubPackages).toEqual(expected)
}

async function readJavaScriptSources(dir: string, root = dir): Promise<Record<string, string>> {
  const sources: Record<string, string> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) Object.assign(sources, await readJavaScriptSources(path, root))
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) sources[relative(root, path).replaceAll("\\", "/")] = await readFile(path, "utf8")
  }
  return sources
}

async function assertOptionalPackagesUnreachable(appDir: string) {
  const script = [
    `const packages = ${JSON.stringify(optionalPackages)}`,
    "const reachable = packages.filter((name) => { try { import.meta.resolve(name); return true } catch { return false } })",
    "process.stdout.write(JSON.stringify(reachable))",
  ].join("\n")
  const { stdout } = await run("node", ["--input-type=module", "--eval", script], appDir)
  expect(JSON.parse(stdout), "optional packages must not resolve from the consumer root").toEqual([])
}

// Agent bundles @t3tools/provider-runtime, which is published only on pkg.pr.new, with the Effect copy it imports
// (#2480). The packed Agent must load its provider entry from its own files and must not name the runtime or Effect
// as installable dependencies. The bundle has no msgpackr, so there is no native addon fallback to exercise. If a
// bundle starts to include msgpackr, this check fails and the pack and unpack round trip with
// MSGPACKR_NATIVE_ACCELERATION_DISABLED must come back.
async function assertProviderRuntimeLoads(appDir: string) {
  const script = [
    "import { readdirSync, readFileSync } from \"node:fs\"",
    "import { createRequire } from \"node:module\"",
    "import { dirname, join } from \"node:path\"",
    "import { pathToFileURL } from \"node:url\"",
    "const viteHubRequire = createRequire(import.meta.resolve(\"vite-hub/package.json\"))",
    "const agentPackage = viteHubRequire.resolve(\"@vite-hub/agent/package.json\")",
    "const manifest = JSON.parse(readFileSync(agentPackage, \"utf8\"))",
    "const sections = [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]",
    "for (const name of [\"@t3tools/provider-runtime\", \"effect\"]) {",
    "  if (sections.some(section => section && name in section)) throw new Error(`Agent must bundle ${name}`)",
    "}",
    "const entry = join(dirname(agentPackage), manifest.imports[\"#vitehub/agent/provider-agent\"].default)",
    "const providerAgent = await import(pathToFileURL(entry).href)",
    "if (typeof providerAgent.createProviderAgentAdapter !== \"function\") throw new Error(\"provider runtime did not load\")",
    "const dist = join(dirname(agentPackage), \"dist\")",
    "const msgpackrFiles = readdirSync(dist, { recursive: true }).map(String)",
    "  .filter(file => file.endsWith(\".js\") && readFileSync(join(dist, file), \"utf8\").includes(\"msgpackr\"))",
    "if (msgpackrFiles.length) throw new Error(`Agent bundles msgpackr in ${msgpackrFiles.join(\", \")}. Test its fallback without the native addon.`)",
  ].join("\n")
  await run("node", ["--input-type=module", "--eval", script], appDir)
}

// Blob driver SDKs are optional peers. A vite-hub-only app must not install them.
async function assertStorageSdksNotInstalled(appDir: string) {
  const script = [
    "import { createRequire } from \"node:module\"",
    "import { pathToFileURL } from \"node:url\"",
    "const viteHub = import.meta.resolve(\"vite-hub/package.json\")",
    "const blob = pathToFileURL(createRequire(viteHub).resolve(\"@vite-hub/blob/package.json\")).href",
    `const packages = ${JSON.stringify(storageSdkPackages)}`,
    "const installed = (name, parent) => { try { import.meta.resolve(name, parent); return true } catch (error) { return error.code !== \"ERR_MODULE_NOT_FOUND\" } }",
    "process.stdout.write(JSON.stringify(packages.filter(name => installed(name, viteHub) || installed(name, blob))))",
  ].join("\n")
  const { stdout } = await run("node", ["--experimental-import-meta-resolve", "--input-type=module", "--eval", script], appDir)
  expect(JSON.parse(stdout), "storage SDKs must not install without the app").toEqual([])
}

// vite-hub and @vite-hub/agent must resolve the same ai. A second ai gives a second @vite-hub/workspace,
// because ai is a Workspace peer, and the two copies reject each other's writable facades.
async function assertOneWorkspaceCopy(appDir: string) {
  const entries = await readdir(join(appDir, "node_modules/.pnpm"))
  const aiVersions = new Set(entries.filter(entry => entry.startsWith("ai@")).map(entry => entry.split("_")[0]))
  expect([...aiVersions], "one ai version").toHaveLength(1)
  expect(entries.filter(entry => entry.startsWith("@vite-hub+workspace@")), "one @vite-hub/workspace copy").toHaveLength(1)
}

describe.skipIf(process.env.VITEHUB_CONSUMER_CONTRACT !== "1")("published vite-hub consumer contract", () => {
  it("serves SSH from a packed vite-hub installation with the app's ssh2 without hoisting", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-sandbox-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")

    try {
      await Promise.all([mkdir(appDir), mkdir(packDir)])
      const specs = await packWorkspacePackages(packDir)
      await Promise.all([
        writeFile(join(appDir, "package.json"), JSON.stringify({
          // ssh2 is an optional peer of @vite-hub/sandbox, and Sandbox is an optional peer of `vite-hub`.
          dependencies: { "@vite-hub/sandbox": specs["@vite-hub/sandbox"], "ssh2": "1.17.0", "vite-hub": specs["vite-hub"] },
          packageManager: "pnpm@10.33.0",
          private: true,
          type: "module",
        }, null, 2), "utf8"),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs), "utf8"),
      ])
      await run("pnpm", ["install", "--no-hoist", "--strict-peer-dependencies"], appDir)
      const hostKey = join(root, "host")
      const identity = join(root, "identity")
      await Promise.all([hostKey, identity].map(path => run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path], appDir)))
      const port = await availablePort()
      const child = spawn(join(appDir, "node_modules/.bin/vitehub"), [
        "sandbox", "serve", "--user", "agent", "--host-key", hostKey,
        "--authorized-key", `${identity}.pub`, "--port", String(port), "--cwd", appDir,
      ], { cwd: appDir, stdio: ["ignore", "pipe", "pipe"] })
      const closed = once(child, "close")
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", chunk => { stdout += String(chunk) })
      child.stderr.on("data", chunk => { stderr += String(chunk) })
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`SSH runner did not start.\n${stdout}${stderr}`)), 10_000)
          const ready = () => {
            if (!stdout.includes("\n")) return
            clearTimeout(timeout)
            resolve()
          }
          child.stdout.on("data", ready)
          child.once("error", error => { clearTimeout(timeout); reject(error) })
          child.once("close", () => { clearTimeout(timeout); reject(new Error(`SSH runner exited before listening.\n${stdout}${stderr}`)) })
        })
        expect(JSON.parse(stdout.trim())).toEqual({ event: "sandbox.listening", port })
        child.kill("SIGTERM")
        expect(await closed).toEqual([0, null])
        expect(stderr).toBe("")
      }
      finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM")
          await closed
        }
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)

  // #3190: an app that enables only Blob and Queue must not install the packages of other features.
  it("installs and builds a Blob and Queue app without the packages of other features", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-lean-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")

    try {
      await Promise.all([mkdir(join(appDir, "server/queues"), { recursive: true }), mkdir(packDir)])
      const specs = await packWorkspacePackages(packDir)
      const framework = JSON.parse(await readFile(join(repoRoot, "packages/vite-hub/package.json"), "utf8")) as PackageManifest
      const optionalPeers = Object.keys(framework.peerDependenciesMeta ?? {})
      // pnpm installs an overridden optional peer, so override only the packages that `vite-hub` requires.
      const requiredSpecs = Object.fromEntries(Object.entries(specs).filter(([name]) => !optionalPeers.includes(name)))
      const config = (features: string) => `
        import { defineConfig } from "vite"
        import { vitehub } from "vite-hub"
        export default defineConfig({ plugins: [vitehub({ env: { public: {} }, preset: "cloudflare", blob: true, queue: true${features} })] })
      `
      await Promise.all([
        writeFile(join(appDir, "vite.config.ts"), config(""), "utf8"),
        writeFile(join(appDir, "server/queues/welcome.ts"), [
          'import { blob } from "vite-hub/blob"',
          'import { defineQueue } from "vite-hub/queue"',
          "export default defineQueue<{ name: string }>(async ({ payload }) => {",
          "  const [error] = await blob.put(`welcome/${payload.name}.txt`, payload.name)",
          "  if (error) throw error",
          "})",
          "",
        ].join("\n"), "utf8"),
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: { "@vite-hub/blob": specs["@vite-hub/blob"], "@vite-hub/queue": specs["@vite-hub/queue"], h3: "2.0.8", nitro: "3.0.261102-rc", vite: "8.2.2", "vite-hub": specs["vite-hub"] },
          packageManager: "pnpm@10.33.0",
          // AI SDK 7's provider declarations need app-visible types with pnpm's hoisting disabled.
          devDependencies: { "@types/json-schema": "7.0.15", "@types/node": "24.19.1", typescript: "6.0.3" },
          private: true,
          type: "module",
        }, null, 2), "utf8"),
        writeFile(join(appDir, "tsconfig.json"), JSON.stringify({
          compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ESNext", noEmit: true, strict: true, skipLibCheck: false, types: ["node"] },
          include: ["vite.config.ts"],
        }, null, 2), "utf8"),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(requiredSpecs), "utf8"),
      ])
      await run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], appDir)

      const installed = await readdir(join(appDir, "node_modules/.pnpm"))
      const featurePackages = ["@vite-hub+agent@", "@vite-hub+auth@", "@vite-hub+realtime@", "@vite-hub+shell@", "@vite-hub+ui@", "better-auth@", "@tiptap+core@", "drizzle-orm@", "drizzle-kit@", "@libsql+client@", "ssh2@", "shiki@", "workflow@", "just-bash@", "effect@"]
      expect(installed.filter(entry => featurePackages.some(prefix => entry.startsWith(prefix)))).toEqual([])
      await run("pnpm", ["exec", "tsc", "--noEmit"], appDir)
      await run("pnpm", ["exec", "vite", "build"], appDir)
      expect(existsSync(join(appDir, ".output/server/index.mjs"))).toBe(true)

      await writeFile(join(appDir, "vite.config.ts"), config(", agent: true"), "utf8")
      await expect(run("pnpm", ["exec", "vite", "build"], appDir)).rejects.toThrow("Install the missing packages in your app with: pnpm add @vite-hub/agent")

      await writeFile(join(appDir, "vite.config.ts"), config(', observability: { service: "lean-app" }'), "utf8")
      await expect(run("pnpm", ["exec", "vite", "build"], appDir)).rejects.toThrow("Install the missing packages in your app with: pnpm add @vite-hub/agent")

      await writeFile(join(appDir, "vite.config.ts"), config(""), "utf8")
      await writeFile(join(appDir, "server/comments.ts"), "export const comments = {}\n", "utf8")
      await expect(run("pnpm", ["exec", "vite", "build"], appDir)).rejects.toThrow("pnpm add @vite-hub/comments @vite-hub/database drizzle-orm")
      await rm(join(appDir, "server/comments.ts"))
      await writeFile(join(appDir, "server/content.cts"), 'export { default } from "./definition"\n', "utf8")
      await writeFile(join(appDir, "server/definition.ts"), 'import { cms } from "vite-hub/cms"\nexport default { extends: cms }\n', "utf8")
      await expect(run("pnpm", ["exec", "vite", "build"], appDir)).rejects.toThrow("pnpm add @vite-hub/content @vite-hub/cms @vite-hub/database drizzle-orm @vite-hub/workspace")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)

  it("stages Node declarations for Deno from the packed facade", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-deno-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")

    try {
      await Promise.all([
        mkdir(appDir, { recursive: true }),
        mkdir(packDir, { recursive: true }),
      ])
      const specs = await packWorkspacePackages(packDir)
      await Promise.all([
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: {
            // Match the exact Nitro peer that ViteHub packages publish from the unjs catalog.
            nitro: "3.0.261102-rc",
            vite: "8.0.8",
            "vite-hub": specs["vite-hub"],
          },
          packageManager: "pnpm@10.33.0",
          private: true,
          type: "module",
        }, null, 2), "utf8"),
        writeFile(join(appDir, "vite.config.mjs"), `
          import { nitro } from "nitro/vite"
          import { defineConfig } from "vite"
          import { vitehub } from "vite-hub"

          export default defineConfig({
            plugins: [vitehub({ preset: "deno" }), nitro()],
          })
        `, "utf8"),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs, {
          "nitro>h3": "2.0.8",
        }), "utf8"),
      ])
      await run("pnpm", ["install", "--no-hoist", "--strict-peer-dependencies"], appDir)
      expect(existsSync(join(appDir, "node_modules/@types/node")), "the app must not own Node declarations").toBe(false)

      await run("pnpm", ["exec", "vite", "build"], appDir)

      await expect(readFile(join(appDir, ".output/deno.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
        compilerOptions: { types: ["./node_modules/@types/node/index.d.ts"] },
      })
      expect(existsSync(join(appDir, ".output/node_modules/@types/node/index.d.ts"))).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)

  it("renders shipped Markdown files through a packed Nuxt route without Agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-nuxt-markdown-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")
    try {
      await Promise.all([
        mkdir(join(appDir, "app"), { recursive: true }),
        mkdir(join(appDir, "server/api"), { recursive: true }),
        mkdir(packDir, { recursive: true }),
      ])
      const specs = await packWorkspacePackages(packDir)
      await Promise.all([
        writeFile(join(appDir, "app/app.vue"), "<template><main>Markdown files</main></template>"),
        writeFile(join(appDir, "nuxt.config.ts"), `
          export default {
            modules: ["vite-hub/nuxt"],
            nitro: { preset: "node-server" },
            vitehub: { agent: false, preset: "node" },
          }
        `),
        writeFile(join(appDir, "server/api/markdown.get.ts"), `
          import { renderMarkdownFile } from "vite-hub/markdown-template/file"
          export default () => renderMarkdownFile(
            ${JSON.stringify(join(appDir, ".output/server/templates/prompt.md"))},
            { data: { name: "Nitro" } },
          )
        `),
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: {
            "@vite-hub/markdown-template": specs["@vite-hub/markdown-template"],
            h3: "2.0.8",
            nitro: "3.0.261102-rc",
            nuxt: "npm:nuxt-nightly@5.0.0-2611031025-9496b7e",
            rolldown: "1.1.5",
            unplugin: "3.3.0",
            vite: "8.0.8",
            "vite-hub": specs["vite-hub"],
          },
          devDependencies: { typescript: "6.0.3", "vite-plus": "0.1.24", "vue-tsc": "3.3.7" },
          packageManager: "pnpm@10.33.0",
          private: true,
          scripts: { build: "nuxt build", typecheck: "nuxt typecheck" },
          type: "module",
        }, null, 2)),
        writeFile(join(appDir, "tsconfig.json"), '{"extends":"./.nuxt/tsconfig.json"}\n'),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs, {
          "oxc-parser": "0.140.0",
          // Nuxt's Nitro and the Nitro that ViteHub depends on must be one copy.
          nitro: "3.0.261102-rc",
          "nitro>h3": "2.0.8",
          rolldown: "1.2.4",
          vite: "npm:@voidzero-dev/vite-plus-core@0.1.24",
        })),
      ])
      await run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], appDir)
      // Markdown Template is the only feature package that this app installs.
      expect(await readdir(join(appDir, "node_modules/@vite-hub"))).toEqual(["markdown-template"])
      await run("pnpm", ["run", "typecheck"], appDir)
      await run("pnpm", ["run", "build"], appDir)
      await mkdir(join(appDir, ".output/server/templates"), { recursive: true })
      await writeFile(join(appDir, ".output/server/templates/prompt.md"), "Hello {{ data.name }}.")
      await withNodeServer(join(appDir, ".output/server/index.mjs"), appDir, async (origin) => {
        const response = await fetch(`${origin}/api/markdown`)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe("Hello Nitro.")
      })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)

  it.each([true, { driver: "kv" }] as const)("auto-imports KV and stores Nitro cache entries through a packed Nuxt route (cache: %j)", async (cache) => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-nuxt-kv-cache-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")
    try {
      await Promise.all([
        mkdir(join(appDir, "app"), { recursive: true }),
        mkdir(join(appDir, "server/api"), { recursive: true }),
        mkdir(packDir, { recursive: true }),
      ])
      const specs = await packWorkspacePackages(packDir)
      await Promise.all([
        writeFile(join(appDir, "app/app.vue"), "<template><main>KV and cache</main></template>"),
        writeFile(join(appDir, "nuxt.config.ts"), `
          export default {
            modules: ["vite-hub/nuxt"],
            nitro: { preset: "node-server" },
            vitehub: { agent: false, cache: ${JSON.stringify(cache)}, kv: true, preset: "node" },
          }
        `),
        // No \`kv\` import: the module auto-imports \`kv\` in server code. Nuxt 5 does not auto-import
        // Nitro 3's \`defineCachedHandler\`, so the route imports it from Nitro.
        writeFile(join(appDir, "server/api/visits.get.ts"), `
          import { defineCachedHandler } from "nitro/cache"

          export default defineCachedHandler(async () => {
            const [readError, visits] = await kv.get("visits")
            if (readError) throw readError
            const next = Number(visits ?? 0) + 1
            const [writeError] = await kv.set("visits", next)
            if (writeError) throw writeError
            return { visits: next }
          }, { maxAge: 3600, name: "visits" })
        `),
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: {
            "@vite-hub/kv": specs["@vite-hub/kv"],
            h3: "2.0.8",
            nitro: "3.0.261102-rc",
            nuxt: "npm:nuxt-nightly@5.0.0-2611031025-9496b7e",
            rolldown: "1.1.5",
            unplugin: "3.3.0",
            vite: "8.0.8",
            "vite-hub": specs["vite-hub"],
          },
          devDependencies: { typescript: "6.0.3", "vite-plus": "0.1.24", "vue-tsc": "3.3.7" },
          packageManager: "pnpm@10.33.0",
          private: true,
          scripts: { build: "nuxt build", typecheck: "nuxt typecheck" },
          type: "module",
        }, null, 2)),
        writeFile(join(appDir, "tsconfig.json"), '{"extends":"./.nuxt/tsconfig.json"}\n'),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs, {
          "oxc-parser": "0.140.0",
          // Nuxt's Nitro and the Nitro that ViteHub depends on must be one copy.
          nitro: "3.0.261102-rc",
          "nitro>h3": "2.0.8",
          rolldown: "1.2.4",
          vite: "npm:@voidzero-dev/vite-plus-core@0.1.24",
        })),
      ])
      await run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], appDir)
      await run("pnpm", ["run", "typecheck"], appDir)
      await run("pnpm", ["run", "build"], appDir)
      await withNodeServer(join(appDir, ".output/server/index.mjs"), appDir, async (origin) => {
        const first = await fetch(`${origin}/api/visits`)
        expect(first.status).toBe(200)
        expect(await first.json()).toEqual({ visits: 1 })
        // The cached handler answers again without running, so KV still holds 1.
        const second = await fetch(`${origin}/api/visits`)
        expect(await second.json()).toEqual({ visits: 1 })
      })
      if (cache === true) expect(existsSync(join(appDir, ".vitehub/data/cache"))).toBe(true)
      else {
        // fs-lite prefixes key files with `key-`, with `:` escaped as `%3A`.
        const files = await readdir(join(appDir, ".vitehub/data/kv"))
        expect(files.some(file => file.startsWith("key-nitro-cache%3A") && file.endsWith(".json"))).toBe(true)
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)

  it("auto-imports typed Queue, KV, and Env server helpers in a packed Nuxt 5 app", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-nuxt-server-imports-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")
    try {
      await Promise.all([
        mkdir(join(appDir, "app"), { recursive: true }),
        mkdir(join(appDir, "server/api"), { recursive: true }),
        mkdir(join(appDir, "server/queues"), { recursive: true }),
        mkdir(packDir, { recursive: true }),
      ])
      const specs = await packWorkspacePackages(packDir)
      // No file imports a ViteHub helper. The module auto-imports them in server code.
      await Promise.all([
        writeFile(join(appDir, "app/app.vue"), "<template><main>Server auto-imports</main></template>"),
        writeFile(join(appDir, "nuxt.config.ts"), `
          export default {
            modules: ["vite-hub/nuxt"],
            nitro: { preset: "node-server" },
            vitehub: { agent: false, kv: true, preset: "node", queue: true },
          }
        `),
        // `defineQueue<...>()` does not compile when `defineQueue` is untyped (TS2347).
        writeFile(join(appDir, "server/queues/welcome.ts"), `
          export default defineQueue<{ id: string }>(async ({ payload }) => {
            const [error] = await kv.set(\`welcome:\${payload.id}\`, "done")
            if (error) throw error
          })
        `),
        writeFile(join(appDir, "server/api/welcome.post.ts"), `
          import { defineEventHandler, getQuery } from "nitro/h3"

          export default defineEventHandler(async (event) => {
            const id = String(getQuery(event).id)
            const [error, result] = await sendQueue("welcome", { id })
            if (error) throw error
            return { queued: Boolean(result), env: typeof useServerEnv() }
          })

          // Each line fails the typecheck when its auto-import is \`any\`, because the directive is then unused.
          export function typeChecks() {
            // @ts-expect-error sendQueue needs a Queue name.
            void sendQueue()
            // @ts-expect-error kv.get needs a key.
            void kv.get()
            // @ts-expect-error useServerEnv takes at most one event.
            void useServerEnv(undefined, undefined)
          }
        `),
        writeFile(join(appDir, "server/api/welcome.get.ts"), `
          import { defineEventHandler, getQuery } from "nitro/h3"

          export default defineEventHandler(async (event) => {
            const [error, value] = await kv.get(\`welcome:\${String(getQuery(event).id)}\`)
            if (error) throw error
            return { value: value ?? null }
          })
        `),
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: {
            "@vite-hub/kv": specs["@vite-hub/kv"],
            "@vite-hub/queue": specs["@vite-hub/queue"],
            h3: "2.0.8",
            nitro: "3.0.261102-rc",
            nuxt: "npm:nuxt-nightly@5.0.0-2611031025-9496b7e",
            rolldown: "1.1.5",
            unplugin: "3.3.0",
            vite: "8.0.8",
            "vite-hub": specs["vite-hub"],
          },
          devDependencies: { typescript: "6.0.3", "vite-plus": "0.1.24", "vue-tsc": "3.3.7" },
          packageManager: "pnpm@10.33.0",
          private: true,
          scripts: { build: "nuxt build", typecheck: "nuxt typecheck" },
          type: "module",
        }, null, 2)),
        writeFile(join(appDir, "tsconfig.json"), '{"extends":"./.nuxt/tsconfig.json"}\n'),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs, {
          "oxc-parser": "0.140.0",
          // Nuxt's Nitro and the Nitro that ViteHub depends on must be one copy.
          nitro: "3.0.261102-rc",
          "nitro>h3": "2.0.8",
          rolldown: "1.2.4",
          vite: "npm:@voidzero-dev/vite-plus-core@0.1.24",
        })),
      ])
      await run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], appDir)
      await run("pnpm", ["run", "typecheck"], appDir)
      // Nuxt writes the server auto-imports and their types here.
      const declarations = await readFile(join(appDir, ".nuxt/types/server-imports.d.ts"), "utf8")
      for (const name of ["defineQueue", "kv", "sendQueue", "useServerEnv"]) expect(declarations).toContain(name)
      await run("pnpm", ["run", "build"], appDir)
      await withNodeServer(join(appDir, ".output/server/index.mjs"), appDir, async (origin) => {
        const queued = await fetch(`${origin}/api/welcome?id=first`, { method: "POST" })
        expect(queued.status).toBe(200)
        expect(await queued.json()).toEqual({ env: "object", queued: true })
        await expect.poll(async () => (await (await fetch(`${origin}/api/welcome?id=first`)).json()) as unknown, { timeout: 10_000 })
          .toEqual({ value: "done" })
      })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)

  it("preserves Agent chat data through a packed Nuxt route", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-nuxt-agent-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")

    try {
      await Promise.all([
        mkdir(join(appDir, "app"), { recursive: true }),
        mkdir(join(appDir, "server/agents"), { recursive: true }),
        mkdir(packDir, { recursive: true }),
      ])
      const specs = await packWorkspacePackages(packDir)
      await Promise.all([
        writeFile(join(appDir, "app/app.vue"), `
          <script setup lang="ts">
          const chat = useChat(useAgent("contract"))
          const title = computed(() => chat.data.value.get("title", "title"))
          </script>
          <template><main>{{ title }}</main></template>
        `, "utf8"),
        writeFile(join(appDir, "nuxt.config.ts"), `
          export default {
            modules: ["vite-hub/nuxt"],
            nitro: { preset: "node-server" },
            vitehub: { agent: true, preset: "node" },
          }
        `, "utf8"),
        writeFile(join(appDir, "server/agents/disabled.ts"), `
          import { defineAgent } from "vite-hub/agent"
          import { webChat } from "vite-hub/agent/channels"

          export default defineAgent({
            channels: { web: webChat({ route: false }) },
            driver: { run: () => "DISABLED_OUTPUT" },
          })
        `, "utf8"),
        writeFile(join(appDir, "server/agents/contract.ts"), `
          import { defineAgent } from "vite-hub/agent"
          import { progressSummary, title } from "vite-hub/agent/capabilities"
          import { webChat } from "vite-hub/agent/channels"

          class HybridResult {
            async *[Symbol.asyncIterator]() {
              yield { text: "GENERIC_OUTPUT", type: "text-delta" }
              yield { type: "finish" }
            }

            toUIMessageStream() {
              return new ReadableStream({
                async start(controller) {
                  controller.enqueue({ messageId: "assistant-1", type: "start" })
                  await new Promise(resolve => setTimeout(resolve, 1_000))
                  controller.enqueue({ id: "text-1", type: "text-start" })
                  controller.enqueue({ delta: "NATIVE_OUTPUT", id: "text-1", type: "text-delta" })
                  controller.enqueue({ id: "text-1", type: "text-end" })
                  await new Promise(resolve => setTimeout(resolve, 30))
                  controller.enqueue({ finishReason: "stop", type: "finish" })
                  controller.close()
                },
              })
            }
          }

          export default defineAgent({
            capabilities: [
              title({ execute: async () => {
                await new Promise(resolve => setTimeout(resolve, 30))
                return "Generated inventory title"
              } }),
              progressSummary({ execute: () => {
                console.log("PROGRESS_TICK")
                return "Checking inventory"
              }, intervalMs: 50 }),
            ],
            channels: { web: webChat() },
            driver: { run: () => new HybridResult() },
          })
        `, "utf8"),
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: {
            "@vite-hub/agent": specs["@vite-hub/agent"],
            "@vite-hub/database": specs["@vite-hub/database"],
            "@vite-hub/workflow": specs["@vite-hub/workflow"],
            "drizzle-orm": "1.0.0-rc.5",
            h3: "2.0.8",
            nitro: "3.0.261102-rc",
            nuxt: "npm:nuxt-nightly@5.0.0-2611031025-9496b7e",
            rolldown: "1.1.5",
            unplugin: "3.3.0",
            vite: "8.0.8",
            "vite-hub": specs["vite-hub"],
          },
          devDependencies: {
            libsql: "0.5.29",
            typescript: "6.0.3",
            "vite-plus": "0.1.24",
            "vue-tsc": "3.3.7",
          },
          optionalDependencies: {
            "@libsql/linux-x64-gnu": "0.5.29",
          },
          packageManager: "pnpm@10.33.0",
          private: true,
          scripts: { build: "nuxt build", typecheck: "nuxt typecheck" },
          type: "module",
        }, null, 2), "utf8"),
        writeFile(join(appDir, "tsconfig.json"), '{"extends":"./.nuxt/tsconfig.json"}\n', "utf8"),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs, {
          "oxc-parser": "0.140.0",
          // Nuxt's Nitro and the Nitro that ViteHub depends on must be one copy.
          nitro: "3.0.261102-rc",
          "nitro>h3": "2.0.8",
          rolldown: "1.2.4",
          vite: "npm:@voidzero-dev/vite-plus-core@0.1.24",
        }), "utf8"),
      ])

      await run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], appDir)
      await assertOnlyViteHubDependencies(appDir, ["@vite-hub/agent", "@vite-hub/database", "@vite-hub/workflow", "vite-hub"])
      await run("pnpm", ["run", "typecheck"], appDir)
      await run("pnpm", ["run", "build"], appDir)

      const server = await withNodeServer(join(appDir, ".output/server/index.mjs"), appDir, async (origin) => {
        const request = {
          body: JSON.stringify({
            id: "packed-contract",
            messages: [{ id: "user-1", parts: [{ text: "Explain inventory health", type: "text" }], role: "user" }],
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        } as const
        const response = await fetch(`${origin}/api/_vitehub/agents/contract/chat`, request)
        const body = await response.text()
        const disabledResponse = await fetch(`${origin}/api/_vitehub/agents/disabled/chat`, request)
        const disabledBody = await disabledResponse.text()
        await new Promise(resolve => setTimeout(resolve, 50))
        return {
          body,
          disabledBody,
          disabledStatus: disabledResponse.status,
          headers: Object.fromEntries(response.headers),
          status: response.status,
        }
      })
      const events = server.value.body
        .split(/\r?\n/)
        .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)) as { data?: { summary?: string, title?: string }, delta?: string, id?: string, type: string })
      const titles = events.filter(event => event.type === "data-title")
      const finishIndex = events.findIndex(event => event.type === "finish")
      const progressIndex = events.findIndex(event => event.type === "data-progress-summary")
      const titleIndexes = events.flatMap((event, index) => event.type === "data-title" ? [index] : [])
      const logs = `${server.logs().stdout}\n${server.logs().stderr}`

      expect(server.value.status, `${server.value.body}\n${server.logs().stdout}\n${server.logs().stderr}`).toBe(200)
      expect(server.value.headers["x-vercel-ai-ui-message-stream"]).toBe("v1")
      expect(events[0]?.type).toBe("start")
      expect(titles).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ title: "Explain inventory health" }), id: "title" }),
        expect.objectContaining({ data: expect.objectContaining({ title: "Generated inventory title" }), id: "title" }),
      ])
      expect(titleIndexes.every(index => index > 0 && index < finishIndex)).toBe(true)
      expect(progressIndex).toBeGreaterThan(0)
      expect(progressIndex).toBeLessThan(finishIndex)
      expect(events, `${server.logs().stdout}\n${server.logs().stderr}`).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ summary: "Checking inventory" }), type: "data-progress-summary" }))
      expect(events).toContainEqual(expect.objectContaining({ delta: "NATIVE_OUTPUT", type: "text-delta" }))
      expect(server.value.body).not.toContain("GENERIC_OUTPUT")
      expect(server.value.disabledStatus).toBe(404)
      expect(server.value.disabledBody).not.toContain("DISABLED_OUTPUT")
      expect(events.at(-1)?.type).toBe("finish")
      expect(logs.match(/PROGRESS_TICK/g)?.length).toBeGreaterThan(1)
      expect(logs).not.toMatch(/AbortError|progressSummary\(\) generation failed|unhandledRejection/i)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)

  it("serves Console operations on the Nuxt development server", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-nuxt-console-dev-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")

    try {
      await Promise.all([
        mkdir(join(appDir, "app"), { recursive: true }),
        mkdir(packDir, { recursive: true }),
      ])
      const specs = await packWorkspacePackages(packDir)
      await Promise.all([
        writeFile(join(appDir, "app/app.vue"), "<template><main>ViteHub</main></template>\n", "utf8"),
        writeFile(join(appDir, "nuxt.config.ts"), `
          export default defineNuxtConfig({
            compatibilityDate: "2026-10-01",
            modules: ["vite-hub/nuxt"],
            vitehub: { console: { auth: false }, comments: false, kv: true, preset: "node" },
          })
        `, "utf8"),
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: {
            "@vite-hub/kv": specs["@vite-hub/kv"],
            h3: "2.0.8",
            nitro: "3.0.261102-rc",
            nuxt: "npm:nuxt-nightly@5.0.0-2611031025-9496b7e",
            rolldown: "1.1.5",
            unplugin: "3.3.0",
            vite: "8.0.8",
            "vite-hub": specs["vite-hub"],
          },
          // The `vite` override selects vite-plus-core, which loads its native binding from vite-plus.
          devDependencies: { "vite-plus": "0.1.24" },
          packageManager: "pnpm@10.33.0",
          private: true,
          type: "module",
        }, null, 2), "utf8"),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs, {
          "oxc-parser": "0.140.0",
          // Nuxt's Nitro and the Nitro that ViteHub depends on must be one copy.
          nitro: "3.0.261102-rc",
          "nitro>h3": "2.0.8",
          rolldown: "1.2.4",
          vite: "npm:@voidzero-dev/vite-plus-core@0.1.24",
        }), "utf8"),
      ])
      await run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], appDir)

      const server = await withDevServer("pnpm", ["exec", "nuxt", "dev", "--no-fork"], appDir, /Ready in/, async (origin) => {
        const sections = await fetch(`${origin}/_vitehub/rpc`, {
          body: JSON.stringify({ m: "sections.list", a: [{}], t: "q", i: "sections" }),
          headers: { "content-type": "application/json", "x-vitehub-console": "1" },
          method: "POST",
        })
        return {
          sections: { body: await sections.text(), status: sections.status },
        }
      })

      expect(server.value.sections.status, server.value.sections.body).toBe(200)
      // The app declares no Server Env, so the navigation hides the empty Env section.
      const sections = JSON.parse(server.value.sections.body)
      expect(sections).toMatchObject({ i: "sections", r: { sections: expect.arrayContaining(["kv"]) }, t: "s" })
      expect(sections.r.sections).not.toContain("env")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)

  it("builds Nuxt database middleware with the app's Database package", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-nuxt-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")

    try {
      await Promise.all([
        mkdir(appDir, { recursive: true }),
        mkdir(packDir, { recursive: true }),
      ])
      const specs = await packWorkspacePackages(packDir)
      await mkdir(join(appDir, "server/databases/default/migrations"), { recursive: true })
      await Promise.all([
        writeFile(join(appDir, "app.vue"), "<template><main>ViteHub</main></template>\n", "utf8"),
        writeFile(join(appDir, "server/databases/default.ts"), [
          'import { defineDatabase } from "vite-hub/database"',
          "export default defineDatabase({ schema: {} })",
          "",
        ].join("\n"), "utf8"),
        writeFile(join(appDir, "server/databases/default/migrations/0001_portable.sql"), "SELECT 1;\n", "utf8"),
        writeFile(join(appDir, "nuxt.config.ts"), `
          export default defineNuxtConfig({
            modules: ["vite-hub/nuxt"],
            nitro: { cloudflare: { deployConfig: true }, preset: "cloudflare_module" },
            vitehub: {
              database: {
                driver: "d1",
                databaseId: "00000000-0000-0000-0000-000000000000",
                databaseName: "portable-db",
              },
              preset: "cloudflare",
            },
          })
        `, "utf8"),
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: {
            "@vite-hub/database": specs["@vite-hub/database"],
            "drizzle-orm": "1.0.0-rc.5",
            h3: "2.0.8",
            nitro: "3.0.261102-rc",
            nuxt: "npm:nuxt-nightly@5.0.0-2611031025-9496b7e",
            rolldown: "1.1.5",
            unplugin: "3.3.0",
            vite: "8.0.8",
            "vite-hub": specs["vite-hub"],
          },
          devDependencies: { "drizzle-kit": "1.0.0-rc.5", "vite-plus": "0.1.24" },
          packageManager: "pnpm@10.33.0",
          private: true,
          scripts: { build: "nuxt build" },
          type: "module",
        }, null, 2), "utf8"),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs, {
          "oxc-parser": "0.140.0",
          // Nuxt's Nitro and the Nitro that ViteHub depends on must be one copy.
          nitro: "3.0.261102-rc",
          "nitro>h3": "2.0.8",
          rolldown: "1.2.4",
          vite: "npm:@voidzero-dev/vite-plus-core@0.1.24",
        }), "utf8"),
      ])
      await run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], appDir)

      await assertOnlyViteHubDependencies(appDir, ["@vite-hub/database", "vite-hub"])
      await run("pnpm", ["run", "build"], appDir)

      const middleware = await readFile(join(appDir, ".vitehub/nitro/database/middleware.ts"), "utf8")
      expect(middleware).toContain("from '@vite-hub/database/runtime/state'")
      expect(middleware).not.toContain("from 'nitro'")

      const artifactDir = join(root, "artifact")
      await cp(join(appDir, ".output/server"), artifactDir, { recursive: true })
      await rm(join(appDir, "server"), { recursive: true })
      const wrangler = JSON.parse(await readFile(join(artifactDir, "wrangler.json"), "utf8")) as {
        d1_databases?: Array<{ migrations_dir?: string }>
      }
      const migrationsDir = wrangler.d1_databases?.[0]?.migrations_dir
      expect(migrationsDir).toBeDefined()
      expect(isAbsolute(migrationsDir!)).toBe(false)
      expect(existsSync(resolve(artifactDir, migrationsDir!))).toBe(true)
      const migrations = await run("vp", [
        "dlx",
        "wrangler@4.147.0",
        "d1",
        "migrations",
        "list",
        "DB",
        "--local",
        "--config",
        join(artifactDir, "wrangler.json"),
        "--persist-to",
        join(artifactDir, ".wrangler"),
      ], artifactDir)
      expect(migrations.stdout).toContain("0001_portable.sql")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)

  it("publishes Browser actions without installing Playwright by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-browser-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")

    try {
      await Promise.all([
        mkdir(appDir, { recursive: true }),
        mkdir(packDir, { recursive: true }),
      ])
      const specs = await packWorkspacePackages(packDir, new Set([
        "@vite-hub/browser",
        "@vite-hub/runtime",
      ]))
      await Promise.all([
        writeFile(join(appDir, "index.ts"), `
          import { runBrowserContent } from "@vite-hub/browser"
          export async function load() {
            return await runBrowserContent("https://example.com")
          }
        `, "utf8"),
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: {
            "@vite-hub/browser": specs["@vite-hub/browser"],
          },
          devDependencies: {
            "@types/node": "24.13.3",
          },
          private: true,
          type: "module",
        }, null, 2), "utf8"),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs), "utf8"),
      ])
      await run("pnpm", ["install", "--no-hoist", "--strict-peer-dependencies"], appDir)
      await assertOnlyViteHubDependencies(appDir, ["@vite-hub/browser"])
      const { stdout: prodDependencies } = await run("pnpm", ["list", "--depth", "Infinity", "--prod", "--json"], appDir)
      expect(prodDependencies).not.toContain("@cloudflare/playwright")
      expect(prodDependencies).not.toContain("playwright-core")
      await run(process.execPath, [
        resolve(repoRoot, "node_modules/typescript/bin/tsc"),
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--noEmit",
        "--strict",
        "--target",
        "ESNext",
        "--types",
        "node",
        "index.ts",
      ], appDir)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it("reports the missing Workspace shell runtime from a packed consumer", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-workspace-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")

    try {
      await Promise.all([
        mkdir(appDir, { recursive: true }),
        mkdir(packDir, { recursive: true }),
      ])
      const specs = await packWorkspacePackages(packDir, new Set([
        // Workspace depends on Forge for its source credentials.
        "@vite-hub/forge",
        "@vite-hub/sandbox",
        "@vite-hub/markdown-template",
        "@vite-hub/runtime",
        "@vite-hub/source",
        "@vite-hub/workspace",
      ]))
      await Promise.all([
        writeFile(join(appDir, "index.ts"), `
          import { createWorkspace } from "@vite-hub/workspace"
          import type {
            History,
            HistoryCheckpoint,
            HistoryCheckpointOptions,
            WorkspacePrepareSessionProgressEvent,
            WorkspaceSessionHost,
          } from "@vite-hub/workspace"

          declare const host: WorkspaceSessionHost
          declare const history: History<HistoryCheckpoint>
          const checkpointOptions: HistoryCheckpointOptions = { message: "packed consumer" }
          void history.checkpoint(checkpointOptions)
          const workspace = createWorkspace({ name: "packed-consumer" })
          void workspace.startSession({
            abortSignal: new AbortController().signal,
            host,
            onProgress(event: WorkspacePrepareSessionProgressEvent) {
              console.log(event.id, event.durationMs, event.data?.bytes, event.data?.files)
            },
            writeBack: { exclude: [".consumer-cache"] },
          })
        `, "utf8"),
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: {
            "@vite-hub/workspace": specs["@vite-hub/workspace"],
            ai: "7.0.19",
          },
          private: true,
          type: "module",
        }, null, 2), "utf8"),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs), "utf8"),
      ])
      await run("pnpm", ["install", "--no-hoist", "--strict-peer-dependencies"], appDir)
      await run(process.execPath, [
        resolve(repoRoot, "node_modules/typescript/bin/tsc"),
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--noEmit",
        "--skipLibCheck",
        "--strict",
        "--target",
        "ESNext",
        "index.ts",
      ], appDir)
      const missingShell = await run("node", ["--input-type=module", "--eval", `
        import { createWorkspaceTools } from "@vite-hub/workspace"
        let shellResolved = true
        try { import.meta.resolve("@vite-hub/shell") } catch { shellResolved = false }
        try {
          await createWorkspaceTools({}).shell.execute({ command: "pwd" })
          throw new Error("Workspace shell unexpectedly loaded")
        }
        catch (error) {
          process.stdout.write(JSON.stringify({
            causeCode: error.cause?.code,
            code: error.code,
            message: error.message,
            name: error.name,
            shellResolved,
          }))
        }
      `], appDir)
      expect(JSON.parse(missingShell.stdout)).toEqual({
        causeCode: "ERR_MODULE_NOT_FOUND",
        code: "WORKSPACE_FAILED",
        message: "[vitehub] Install @vite-hub/shell to use Workspace Tools shell commands.",
        name: "ViteHubError",
        shellResolved: false,
      })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it("installs, typechecks, and builds without workspace or hoisting access", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-hub-consumer-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")

    try {
      await Promise.all([
        cp(fixtureRoot, appDir, { recursive: true }),
        mkdir(packDir, { recursive: true }),
      ])
      await assertOnlyViteHubDependencies(appDir, fixtureViteHubPackages)

      const specs = await packWorkspacePackages(packDir)
      await usePackedPeerManifests(appDir, specs)
      await writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs), "utf8")
      await run("pnpm", ["install", "--no-hoist", "--strict-peer-dependencies"], appDir)

      // The owner packages of opt-in features come from the app. `vite-hub` installs its own packages out of sight.
      await run("node", [
        "--input-type=module",
        "--eval",
        "let resolved = false; try { import.meta.resolve('@vite-hub/runtime'); resolved = true } catch {} if (resolved) throw new Error('a bundled owner package resolved from the consumer root')",
      ], appDir)
      await assertOptionalPackagesUnreachable(appDir)
      await assertStorageSdksNotInstalled(appDir)
      await assertOneWorkspaceCopy(appDir)
      await assertProviderRuntimeLoads(appDir)

      await run("pnpm", ["run", "typecheck"], appDir)
      const emailSecretSentinel = "re_vitehub-email-build-secret"
      await run("pnpm", ["run", "build"], appDir, {
        ...process.env,
        RESEND_API_KEY: emailSecretSentinel,
      })
      await run("pnpm", ["run", "typecheck"], appDir)
      const generatedEnvTypes = await readFile(join(appDir, ".vitehub/env/server.d.ts"), "utf8")
      expect(generatedEnvTypes).toMatch(/import\("[^"\n]*[\\/]env[\\/]dist[\\/]internal[\\/]server\.js"\)\.EnvAccessContext/)
      expect(generatedEnvTypes).not.toContain('import("@vite-hub/env/bridge")')
      await writeFile(join(appDir, "env-typecheck.json"), JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          types: ["node"],
        },
        files: [".vitehub/env/server.d.ts", ".vitehub/types/env.d.ts"],
      }), "utf8")
      await run("pnpm", ["exec", "tsc", "-p", "env-typecheck.json"], appDir)

      // Nitro writes the Node server to .output/server (#2566).
      const nodeEmailSources = await readJavaScriptSources(join(appDir, ".output/server"))
      const nodeEmailOutput = Object.values(nodeEmailSources).join("\n")
      expect(nodeEmailOutput).toContain("RESEND_API_KEY")
      expect(nodeEmailOutput).toContain("api.resend.com")
      expect(nodeEmailOutput).not.toContain(emailSecretSentinel)

      const help = await run("pnpm", ["exec", "vitehub", "--help"], appDir)
      expect(help.stdout).toContain("Usage: vitehub")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 3_600_000)
})
