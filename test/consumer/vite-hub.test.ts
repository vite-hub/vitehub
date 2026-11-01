import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
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
const fixtureViteHubPackages = ["@vite-hub/agent", "@vite-hub/auth", "@vite-hub/database", "@vite-hub/schedule", "@vite-hub/workspace", "vite-hub"]

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

/** Runs a development server until its log matches `ready`. Nitro 2 answers 500 while it still builds the server. */
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

  expect(manifest.dependencies).toMatchObject({
    "@workflow/builders": expect.any(String),
    workflow: expect.any(String),
  })

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

function workspaceConfig(specs: Record<string, string>, additionalOverrides: Record<string, string> = {}) {
  const overrides = Object.entries({
    ...specs,
    ...additionalOverrides,
  })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`)

  return [
    "packages:",
    "  - .",
    "allowBuilds:",
    "  esbuild: true",
    "  msgpackr-extract: false",
    "blockExoticSubdeps: false",
    "overrides:",
    // Rolldown rc.15 pins @emnapi/* 1.9.2, while wasm-runtime 1.2 requires incompatible 2.x peers.
    "  \"@napi-rs/wasm-runtime\": \"1.1.6\"",
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

async function readJavaScript(dir: string): Promise<string> {
  const chunks: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) chunks.push(await readJavaScript(path))
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) chunks.push(await readFile(path, "utf8"))
  }
  return chunks.join("\n")
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

async function readGeneratedSources(dir: string, root = dir): Promise<Record<string, string>> {
  const sources: Record<string, string> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) Object.assign(sources, await readGeneratedSources(path, root))
    else if (/\.[cm]?[jt]s$/.test(entry.name)) sources[relative(root, path).replaceAll("\\", "/")] = await readFile(path, "utf8")
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

function importSpecifierOccurrences(source: string) {
  const pattern = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g
  return [...source.matchAll(pattern)].map(match => ({
    line: source.slice(0, match.index).split("\n").length,
    specifier: match[1]!,
  }))
}

function isOptionalPackageSpecifier(specifier: string) {
  return optionalPackages.some(name => specifier === name || specifier.startsWith(`${name}/`))
}

function assertProviderRuntimeReachabilityClosed(
  provider: string,
  sources: Record<string, string>,
) {
  const output = Object.values(sources).join("\n")
  for (const marker of [
    "@modelcontextprotocol/sdk",
    "@vite-hub/agent",
    "@vite-hub/source",
    "@vite-hub/workspace",
    "@octokit/",
    "mcp-resources",
    "pkce-challenge",
    "rollup/dist/",
    "vite/dist/node",
  ]) {
    expect(output, `${provider} output must not reach ${marker}`).not.toContain(marker)
  }
  const forbiddenPackagePaths = [
    "node_modules/@modelcontextprotocol/sdk/",
    "node_modules/@vite-hub/agent/",
    "node_modules/@vite-hub/sandbox/",
    "node_modules/@vite-hub/source/",
    "node_modules/@vite-hub/workspace/",
    "node_modules/pkce-challenge/",
  ]
  const reachedPackages = Object.keys(sources).filter(file => forbiddenPackagePaths.some(path => file.includes(path)))
  expect(reachedPackages, `${provider} output must not copy forbidden runtime packages`).toEqual([])
}

async function resolveEsmSpecifiers(entries: Array<{ parent: string, specifier: string }>) {
  const script = [
    "const entries = JSON.parse(process.argv[1])",
    "const results = entries.map(({ parent, specifier }) => {",
    "  try { return { resolved: import.meta.resolve(specifier, parent) } }",
    "  catch (error) { return { error: error instanceof Error ? error.message : String(error) } }",
    "})",
    "process.stdout.write(JSON.stringify(results))",
  ].join("\n")
  const { stdout } = await execFileAsync(process.execPath, [
    "--experimental-import-meta-resolve",
    "--input-type=module",
    "--eval",
    script,
    JSON.stringify(entries),
  ], { maxBuffer })
  return JSON.parse(String(stdout)) as Array<{ error?: string, resolved?: string }>
}

async function assertVercelRuntimeImportsResolveInside(
  functionsRoot: string,
  sources: Record<string, string>,
  message: string,
) {
  const runtimeImports = Object.entries(sources).flatMap(([file, source]) =>
    importSpecifierOccurrences(source)
      .filter(({ specifier }) => specifier.startsWith("@vite-hub/"))
      .map(occurrence => ({ file, ...occurrence })),
  ).map((occurrence) => {
    const functionSegment = occurrence.file.split("/").findIndex(segment => segment.endsWith(".func"))
    if (functionSegment < 0) return { ...occurrence }
    const functionDir = join(functionsRoot, ...occurrence.file.split("/").slice(0, functionSegment + 1))
    const importer = join(functionsRoot, occurrence.file)
    return { ...occurrence, functionDir, importer }
  })
  const invalid = runtimeImports
    .filter(entry => !("functionDir" in entry) || !("importer" in entry))
    .map(entry => ({ ...entry, reason: "importer is outside a Vercel function" }))
  const contained = runtimeImports.filter(
    (entry): entry is typeof entry & { functionDir: string, importer: string } => "functionDir" in entry && "importer" in entry,
  )
  const resolutions = await resolveEsmSpecifiers(contained.map(entry => ({
    parent: pathToFileURL(entry.importer).href,
    specifier: entry.specifier,
  })))

  for (const [index, entry] of contained.entries()) {
    const resolution = resolutions[index]
    if (!resolution?.resolved) {
      invalid.push({ ...entry, reason: resolution?.error || "specifier did not resolve" })
      continue
    }
    const resolved = await realpath(fileURLToPath(resolution.resolved))
    const functionDir = await realpath(entry.functionDir)
    const fromFunction = relative(functionDir, resolved)
    if (fromFunction === ".." || fromFunction.startsWith(`..${sep}`) || isAbsolute(fromFunction)) {
      invalid.push({ ...entry, reason: `resolved outside function to ${resolved}` })
    }
  }

  expect(invalid, message).toEqual([])
}

function isRetainedProviderSource(file: string) {
  return /(?:^|\/)\.vitehub\/(?:schedule|workflow)\/sources\//.test(file)
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
          // ssh2 is an optional peer of @vite-hub/sandbox, so `vite-hub` does not install it.
          dependencies: { "ssh2": "1.17.0", "vite-hub": specs["vite-hub"] },
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
        export default defineConfig({ plugins: [vitehub({ preset: "cloudflare", blob: true, queue: true${features} })] })
      `
      await Promise.all([
        writeFile(join(appDir, "vite.config.ts"), config(""), "utf8"),
        writeFile(join(appDir, "server/queues/welcome.ts"), [
          'import { blob } from "vite-hub/blob"',
          'import { defineQueue } from "vite-hub/queue"',
          "export default defineQueue<{ name: string }>(async ({ payload }) => {",
          "  await blob.put(`welcome/${payload.name}.txt`, payload.name)",
          "})",
          "",
        ].join("\n"), "utf8"),
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: { h3: "2.0.1-rc.33", nitro: "3.0.260903-beta", vite: "8.2.2", "vite-hub": specs["vite-hub"] },
          private: true,
          type: "module",
        }, null, 2), "utf8"),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(requiredSpecs), "utf8"),
      ])
      await run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], appDir)

      const installed = await readdir(join(appDir, "node_modules/.pnpm"))
      const featurePackages = ["@vite-hub+agent@", "@vite-hub+auth@", "@vite-hub+realtime@", "@vite-hub+shell@", "@vite-hub+ui@", "better-auth@", "@tiptap+core@", "drizzle-orm@", "drizzle-kit@", "@libsql+client@", "ssh2@", "shiki@", "workflow@", "just-bash@", "effect@"]
      expect(installed.filter(entry => featurePackages.some(prefix => entry.startsWith(prefix)))).toEqual([])
      await run("pnpm", ["exec", "vite", "build"], appDir)
      expect(existsSync(join(appDir, ".output/server/index.mjs"))).toBe(true)

      await writeFile(join(appDir, "vite.config.ts"), config(", agent: true"), "utf8")
      await expect(run("pnpm", ["exec", "vite", "build"], appDir)).rejects.toThrow("Install the missing packages in your app with: pnpm add @vite-hub/agent")
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
            nitro: "3.0.260903-beta",
            vite: "8.0.8",
            "vite-hub": specs["vite-hub"],
          },
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
          "nitro>h3": "2.0.1-rc.33",
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
            h3: "2.0.1-rc.33",
            nitro: "3.0.260903-beta",
            nuxt: "npm:nuxt-nightly@5.0.0-2610221052-8c52432",
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
          "nitro>h3": "2.0.1-rc.33",
          rolldown: "1.2.4",
          vite: "npm:@voidzero-dev/vite-plus-core@0.1.24",
        })),
      ])
      await run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], appDir)
      expect(existsSync(join(appDir, "node_modules/@vite-hub"))).toBe(false)
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
            h3: "2.0.1-rc.33",
            nitro: "3.0.260903-beta",
            nuxt: "npm:nuxt-nightly@5.0.0-2610221052-8c52432",
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
          "nitro>h3": "2.0.1-rc.33",
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
        const keys = await readdir(join(appDir, ".vitehub/data/kv/nitro-cache"), { recursive: true })
        expect(keys.some(key => key.endsWith(".json"))).toBe(true)
      }
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
            h3: "2.0.1-rc.33",
            nitro: "3.0.260903-beta",
            nuxt: "npm:nuxt-nightly@5.0.0-2610221052-8c52432",
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
          "nitro>h3": "2.0.1-rc.33",
          rolldown: "1.2.4",
          vite: "npm:@voidzero-dev/vite-plus-core@0.1.24",
        }), "utf8"),
      ])

      await run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], appDir)
      await assertOnlyViteHubDependencies(appDir, ["@vite-hub/agent", "vite-hub"])
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

  it("serves the Console on the Nuxt 4 development server", async () => {
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
            vitehub: { console: { auth: false }, kv: true, preset: "node" },
          })
        `, "utf8"),
        writeFile(join(appDir, "package.json"), JSON.stringify({
          dependencies: {
            nuxt: "4.6.2",
            unplugin: "3.3.0",
            vite: "8.0.8",
            "vite-hub": specs["vite-hub"],
          },
          packageManager: "pnpm@10.33.0",
          private: true,
          type: "module",
        }, null, 2), "utf8"),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs, {
          "oxc-parser": "0.140.0",
          rollup: "4.64.0",
        }), "utf8"),
      ])
      await run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], appDir)

      // Nuxt 4 runs Nitro 2, which leaves modules outside its inline list to Node in development.
      const server = await withDevServer("pnpm", ["exec", "nuxt", "dev", "--no-fork"], appDir, /Ready in/, async (origin) => {
        const page = await fetch(`${origin}/_vitehub`)
        const sections = await fetch(`${origin}/_vitehub/rpc/__call`, {
          body: JSON.stringify({ operation: "sections.list", input: {} }),
          headers: { "content-type": "application/json", "x-vitehub-console": "1" },
          method: "POST",
        })
        return {
          page: { body: await page.text(), status: page.status },
          sections: { body: await sections.text(), status: sections.status },
        }
      })

      expect(server.value.page.status, `${server.value.page.body}\n${server.logs()}`).toBe(200)
      expect(server.value.page.body).toContain("<title>ViteHub Console</title>")
      expect(server.value.sections.status, server.value.sections.body).toBe(200)
      expect(JSON.parse(server.value.sections.body)).toMatchObject({ ok: true, value: { sections: expect.arrayContaining(["env", "kv"]) } })
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
      await mkdir(join(appDir, "server/databases/migrations"), { recursive: true })
      await Promise.all([
        writeFile(join(appDir, "app.vue"), "<template><main>ViteHub</main></template>\n", "utf8"),
        writeFile(join(appDir, "server/databases/config.ts"), [
          'import { defineDatabase } from "vite-hub/database"',
          "export default defineDatabase({ schema: {} })",
          "",
        ].join("\n"), "utf8"),
        writeFile(join(appDir, "server/databases/migrations/0001_portable.sql"), "SELECT 1;\n", "utf8"),
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
            "drizzle-orm": "0.45.3",
            nuxt: "4.5.2",
            unplugin: "3.3.0",
            vite: "8.0.8",
            "vite-hub": specs["vite-hub"],
          },
          devDependencies: { "drizzle-kit": "0.31.11" },
          packageManager: "pnpm@10.33.0",
          private: true,
          scripts: { build: "nuxt build" },
          type: "module",
        }, null, 2), "utf8"),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs, {
          "oxc-parser": "0.140.0",
          // Keep Nitro's native Rollup package on the workspace-tested release.
          rollup: "4.64.0",
        }), "utf8"),
      ])
      await run("pnpm", ["install", "--no-hoist", "--strict-peer-dependencies"], appDir)

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
        "wrangler@4.112.0",
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
          import { runBrowserContent } from "@vite-hub/browser/actions"
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
        import { createWorkspaceTools } from "@vite-hub/workspace/ai"
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
      await writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs), "utf8")
      await run("pnpm", ["install", "--no-hoist", "--strict-peer-dependencies"], appDir)

      // The owner packages of opt-in features come from the app. `vite-hub` installs the others out of sight.
      await run("node", [
        "--input-type=module",
        "--eval",
        "let resolved = false; try { import.meta.resolve('@vite-hub/blob'); resolved = true } catch {} if (resolved) throw new Error('a bundled owner package resolved from the consumer root')",
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
      expect(generatedEnvTypes).toContain('import("vite-hub/env/server").EnvAccessContext')
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

      for (const alias of ["vitehub", "vite-hub"]) {
        const help = await run("pnpm", ["exec", alias, "--help"], appDir)
        expect(help.stdout).toContain("Usage: vitehub")
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 3_600_000)

  // Skipped: these stages predate Nitro as the only host output (#2566). They read the removed dist/ layout
  // (dist/app for Cloudflare, dist/client, and dist/server through the fixture runtime smoke), and they never ran
  // after that change because earlier stages of the consumer contract failed first. The fixture's second
  // \`vite build --ssr server-entry.ts --outDir dist/server\` now writes into Nitro's .output/public instead.
  // Re-enable them once the fixture and these stages use the .output, .vercel/output, and .netlify layouts.
  it.skip("builds Vercel, Cloudflare, and Netlify outputs from the packed fixture", async () => {
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
      await writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(specs), "utf8")
      await run("pnpm", ["install", "--no-hoist", "--strict-peer-dependencies"], appDir)

      {
        await Promise.all([
          rm(join(appDir, ".vercel"), { force: true, recursive: true }),
          rm(join(appDir, ".vitehub"), { force: true, recursive: true }),
          rm(join(appDir, "dist"), { force: true, recursive: true }),
        ])
        await run("pnpm", ["exec", "vite", "build"], appDir, {
        ...process.env,
        VITEHUB_PROVIDER_SANDBOX_CLOSURE: "1",
        VITEHUB_PRESET: "vercel",
      })
      expect(existsSync(join(appDir, ".vercel", "output", "functions", "__queue.func"))).toBe(false)
      const queueCallback = join(
        appDir,
        ".vercel",
        "output",
        "functions",
        "api",
        "vitehub",
        "queues",
        "vercel",
        "welcome.func",
        "index.mjs",
      )
      expect(JSON.parse(await readFile(join(dirname(queueCallback), ".vc-config.json"), "utf8"))).toMatchObject({
        experimentalTriggers: [{ consumer: "api_Svitehub_Squeues_Svercel_Swelcome_Dfunc", type: "queue/v2beta" }],
      })
      const callbackInvocation = await run(
        "node",
        [
          "--input-type=module",
          "--eval",
          `
        import { pathToFileURL } from "node:url"
        const oidcPayload = Buffer.from(JSON.stringify({ owner_id: "offline-team", project_id: "offline-project" })).toString("base64url")
        process.env.VERCEL_OIDC_TOKEN = ["e30", oidcPayload, "offline-signature"].join(".")
        const handler = (await import(pathToFileURL(${JSON.stringify(queueCallback)}).href)).default
        globalThis.__vitehubVercelQueue = {
          handleCallback: callback => async () => {
            await callback({ queued: true }, { deliveryCount: 1, messageId: "sandbox-message" })
            return new Response("handled")
          },
          send: async () => ({ messageId: "unused" }),
        }
        globalThis.fetch = async input => { throw new Error("offline provider proof: " + String(input)) }
        const response = await handler.fetch(new Request("http://127.0.0.1/api/vitehub/queues/vercel/welcome", { method: "POST" }), {})
        const body = await response.text()
        if (response.status !== 200 || body !== "handled") throw new Error("Queue callback failed: " + response.status + " " + body)
        process.stdout.write(JSON.stringify(globalThis.__vitehubQueueSandboxTaskResult))
      `,
        ],
        appDir,
      )
      const sandboxTaskResult = JSON.parse(callbackInvocation.stdout) as {
        code?: string
        message?: string
        optimized?: boolean
      }
      expect(sandboxTaskResult.message || "").toContain("offline provider proof:")
      expect(sandboxTaskResult.message || "").not.toContain('Unknown Sandbox Task "image-optimizer"')
      expect(sandboxTaskResult.message || "").not.toContain("requires @vercel/sandbox")
      expect(sandboxTaskResult.message || "").not.toContain("Cannot find package")
      expect(sandboxTaskResult.code || "").not.toBe("ERR_MODULE_NOT_FOUND")

      const vercelFunctionsRoot = join(appDir, ".vercel/output/functions")
      const queueFunctionRoot = dirname(queueCallback)
      const immediateVercelSources = await readJavaScriptSources(queueFunctionRoot)
      const immediateVercelRuntimeSources = Object.fromEntries(Object.entries(immediateVercelSources).filter(([file]) =>
        !/(?:^|\/)node_modules\/.*\.(?:spec|test)\.(?:m?js)$/.test(file),
      ))
      const immediateVercelOptionalImports = Object.entries(immediateVercelRuntimeSources).flatMap(([file, source]) =>
        importSpecifierOccurrences(source)
          .filter(({ specifier }) => isOptionalPackageSpecifier(specifier))
          .map(occurrence => ({ file, ...occurrence })),
      )
      expect(immediateVercelOptionalImports, "Fresh Vercel functions must not ship opt-in packages").toEqual([])
      assertProviderRuntimeReachabilityClosed("Fresh Vercel", immediateVercelRuntimeSources)
      await assertVercelRuntimeImportsResolveInside(
        queueFunctionRoot,
        immediateVercelRuntimeSources,
        "Fresh Vercel runtime imports must resolve inside their own function output",
      )

      await run("pnpm", ["exec", "vite", "build"], appDir, {
        ...process.env,
        VITEHUB_PROVIDER_SANDBOX_CLOSURE: "1",
        VITEHUB_PRESET: "cloudflare",
      })
      expect(existsSync(join(appDir, "dist", "app", "index.js"))).toBe(true)

      const [authTypes, authServerTypes, blobPlugin, envServer, scheduleRegistryTypes] = await Promise.all([
        readFile(join(appDir, ".vitehub/types/auth.d.ts"), "utf8"),
        readFile(join(appDir, ".vitehub/types/auth-server.d.ts"), "utf8"),
        readFile(join(appDir, ".vitehub/nitro/blob/plugin.ts"), "utf8"),
        readFile(join(appDir, ".vitehub/env/server.mjs"), "utf8"),
        readFile(join(appDir, ".vitehub/nitro/schedule/provider-registry.d.ts"), "utf8"),
      ])
      const generatedSources = await readGeneratedSources(join(appDir, ".vitehub"))
      const bareOwnerPackageSpecifiers = Object.entries(generatedSources).flatMap(([file, source]) =>
        file.endsWith(".d.ts") || file.includes("/.runtime-generations/")
          ? []
          : source.split("\n")
              .map((line, index) => ({ file, line: index + 1, source: line.trim() }))
              .filter(line => /["']@vite-hub\/[^"']+["']/.test(line.source)),
      )
      expect(bareOwnerPackageSpecifiers, "generated app-local code must not expose bare owner-package specifiers").toEqual([])

      expect(authTypes).toContain("namespace ViteHub")
      expect(authServerTypes).toContain("vite-hub/auth/server")
      expect(blobPlugin).toContain("vite-hub/_internal/blob/runtime/state")
      expect(envServer).toContain("vite-hub/env/server")
      expect(scheduleRegistryTypes).toContain("vite-hub/_internal/schedule")

      expect(existsSync(join(vercelFunctionsRoot, "__queue.func/index.mjs"))).toBe(false)
      expect(existsSync(queueCallback)).toBe(false)

      const cloudflareSources = await readJavaScriptSources(join(appDir, "dist/app"))
      const cloudflareRuntimeSources = Object.fromEntries(Object.entries(cloudflareSources).filter(([file]) =>
        !isRetainedProviderSource(file),
      ))
      const cloudflareWrangler = JSON.parse(await readFile(join(appDir, "dist/app/wrangler.json"), "utf8")) as {
        compatibility_flags?: string[]
      }
      expect(cloudflareWrangler.compatibility_flags).toContain("nodejs_compat")

      const cloudflareExternalImports = Object.entries(cloudflareRuntimeSources).flatMap(([file, source]) =>
        importSpecifierOccurrences(source)
          .filter(({ specifier }) => specifier.startsWith("@vite-hub/") || isOptionalPackageSpecifier(specifier))
          .map(occurrence => ({ file, ...occurrence })),
      )
      expect(cloudflareExternalImports, "Cloudflare output must bundle owner packages and exclude opt-in packages").toEqual([])
      expect(Object.values(cloudflareRuntimeSources).join("\n")).toContain("getSandbox")
      assertProviderRuntimeReachabilityClosed("Cloudflare", cloudflareRuntimeSources)
      }

      await Promise.all([
        rm(join(appDir, ".vercel"), { force: true, recursive: true }),
        rm(join(appDir, ".vitehub"), { force: true, recursive: true }),
        rm(join(appDir, "dist"), { force: true, recursive: true }),
      ])
      await run("pnpm", ["exec", "vite", "build"], appDir, {
        ...process.env,
        VITEHUB_PRESET: "vercel",
      })
      const [nativeWorkflowFile] = await readdir(join(appDir, ".vitehub/workflow/vercel-native"))
      const [agentRoute, authTypes, authServerTypes, blobPlugin, emailTemplate, envServer, workflowRegistry, workspacePlugin, nativeWorkflow, scheduleFunction, flowBundle, vercelConfig] = await Promise.all([
        readFile(join(appDir, ".vitehub/agent/chat-webhook-route.ts"), "utf8"),
        readFile(join(appDir, ".vitehub/types/auth.d.ts"), "utf8"),
        readFile(join(appDir, ".vitehub/types/auth-server.d.ts"), "utf8"),
        readFile(join(appDir, ".vitehub/nitro/blob/plugin.ts"), "utf8"),
        readFile(join(appDir, ".vitehub/email/templates/welcome.mjs"), "utf8"),
        readFile(join(appDir, ".vitehub/env/server.mjs"), "utf8"),
        readFile(join(appDir, ".vitehub/workflow/registry.mjs"), "utf8"),
        readFile(join(appDir, ".vitehub/nitro/workspace/plugin.ts"), "utf8"),
        readFile(join(appDir, ".vitehub/workflow/vercel-native", nativeWorkflowFile), "utf8"),
        readFile(join(appDir, ".vercel/output/functions/api/vitehub/schedules/vercel/heartbeat.func/index.mjs"), "utf8"),
        readFile(join(appDir, ".vercel/output/functions/.well-known/workflow/v1/flow.func/index.mjs"), "utf8"),
        readFile(join(appDir, ".vercel/output/config.json"), "utf8"),
      ])
      expect(agentRoute).toContain("vite-hub/_internal/agent")
      expect(agentRoute).toContain("vite-hub/_internal/workspace/runtime")
      expect(authTypes).toContain("namespace ViteHub")
      expect(authServerTypes).toContain("vite-hub/auth/server")
      expect(blobPlugin).toContain("vite-hub/_internal/blob/runtime/state")
      expect(emailTemplate).toContain("Welcome")
      expect(envServer).toContain("vite-hub/env/server")
      expect(workflowRegistry).toContain("vite-hub/_internal/agent")
      expect(workflowRegistry).toContain("setAgentWorkflowRuntimeLoaders")
      expect(workflowRegistry).toContain("vite-hub/_internal/workflow/runtime/execute")
      expect(workflowRegistry).toContain("vite-hub/_internal/workflow/runtime/state")
      expect(workflowRegistry).toContain("setWorkspaceDependencyRuntimeLoaders")
      expect(workflowRegistry).not.toContain("vite-hub/_internal/sandbox/task/runtime/state")
      expect(workflowRegistry).not.toContain("vite-hub/sandbox/task")
      expect(workflowRegistry).toContain("vite-hub/shell/workspace")
      expect(workspacePlugin).toContain("vite-hub/_internal/workspace/runtime")
      expect(nativeWorkflow).toContain('"use workflow"')
      expect(nativeWorkflow).toContain('"use step"')
      expect(nativeWorkflow).not.toContain("vitehub.email.definition")
      expect(scheduleFunction).toContain("setWorkflowRuntimeRegistry")
      expect(flowBundle).toContain("vitehub.email.definition")
      expect(flowBundle).toContain("RESEND_API_KEY")
      expect(flowBundle).toMatch(/globalThis\[(?:\/\*.*?\*\/\s*)?Symbol\.for\(["']vitehub\.email\.definition["']\)\]\s*=/)
      expect(JSON.parse(vercelConfig).crons).toContainEqual({
        path: "/api/vitehub/schedules/vercel/heartbeat",
        schedule: "0 0 * * *",
      })

      await run("pnpm", ["run", "build"], appDir, process.env)
      const smoke = await run("pnpm", ["run", "smoke"], appDir)
      expect(smoke.stdout).toContain("vite-hub runtime smoke ok")

      const vercelFunctionsRoot = join(appDir, ".vercel/output/functions")
      const vercelSources = await readJavaScriptSources(vercelFunctionsRoot)
      const vercelRuntimeSources = Object.fromEntries(Object.entries(vercelSources).filter(([file]) =>
        !isRetainedProviderSource(file) && !/(?:^|\/)node_modules\/.*\.(?:spec|test)\.(?:m?js)$/.test(file),
      ))
      await assertVercelRuntimeImportsResolveInside(
        vercelFunctionsRoot,
        vercelRuntimeSources,
        "Vercel runtime imports must resolve inside their own function output",
      )

      await run("pnpm", ["exec", "vite", "build"], appDir, {
        ...process.env,
        VITEHUB_CONSUMER_DISABLE_WORKSPACE: "1",
      })
      const workspaceDisabledVercelSources = await readJavaScriptSources(vercelFunctionsRoot)
      const workspaceDisabledVercelImports = Object.entries(workspaceDisabledVercelSources)
        .filter(([file]) => !isRetainedProviderSource(file))
        .flatMap(([file, source]) =>
          importSpecifierOccurrences(source)
            .filter(({ specifier }) => specifier === "@vite-hub/workspace" || specifier.startsWith("@vite-hub/workspace/"))
            .map(occurrence => ({ file, ...occurrence })),
        )
      expect(workspaceDisabledVercelImports, "canonical Workflow output must bundle Workspace when its Vite plugin is disabled").toEqual([])

      await run("pnpm", ["exec", "vite", "build"], appDir, { ...process.env, VITEHUB_HOSTING: "netlify", VITEHUB_PRESET: "netlify" })
      const netlifyFunctionPath = join(appDir, ".netlify/v1/functions/vitehub-agent.mjs")
      const netlifyFunctionSource = await readFile(netlifyFunctionPath, "utf8")
      const netlifyProviderImports = importSpecifierOccurrences(netlifyFunctionSource)
        .filter(({ specifier }) => specifier === "vite-hub" || specifier.startsWith("vite-hub/") || specifier.startsWith("@vite-hub/"))
      expect(netlifyProviderImports, "Netlify Agent output must bundle canonical and owner-package imports").toEqual([])
      const netlifyInvocation = await run("node", ["--input-type=module", "--eval", `
        const handler = await import(${JSON.stringify(pathToFileURL(netlifyFunctionPath).href)})
        const tasks = []
        const response = await handler.default(new Request("https://example.com/api/_vitehub/agents/echo/chat", {
          body: JSON.stringify({ messages: [{ id: "user-1", parts: [{ text: "netlify", type: "text" }], role: "user" }] }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }), { waitUntil: task => tasks.push(task) })
        const body = await response.text()
        await Promise.all(tasks)
        process.stdout.write("VITEHUB_CONSUMER_RESULT:" + JSON.stringify({ body, status: response.status }))
      `], appDir)
      const netlifyResponse = JSON.parse(netlifyInvocation.stdout.split("VITEHUB_CONSUMER_RESULT:").at(-1)!) as { body: string, status: number }
      expect(netlifyResponse.status).toBe(200)
      expect(netlifyResponse.body).toContain("VITE_HUB_SERVER_ONLY:/workspace")

      expect(workflowRegistry).toContain('"roundtrip"')
      await expect(readFile(join(appDir, ".vitehub/types/workspace.d.ts"), "utf8")).resolves.toContain('"docs"')

      const client = await readJavaScript(join(appDir, "dist/client"))
      expect(client).toContain("VITE_HUB_CONSUMER_CLIENT")
      for (const forbidden of [
        "VITE_HUB_SERVER_ONLY",
        "node:fs",
        "node:path",
        "@vite-hub/agent",
        "@vite-hub/workflow",
        "@vite-hub/workspace",
        "@cloudflare/",
        "@vercel/",
      ]) {
        expect(client, `browser output contains server-only edge ${forbidden}`).not.toContain(forbidden)
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 3_600_000)
})
