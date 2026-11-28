import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, posix, resolve } from "node:path"
import { promisify } from "node:util"

import { expect } from "vitest"
import { parse as parseYaml } from "yaml"

import { featureIds } from "../../packages/internal/src/features.ts"
import { packedWorkspacePackages } from "../../packages/internal/test-utils/published-types.ts"
import { listWorkspacePackageInfos } from "../../packages/internal/src/workspace-inventory.ts"
import { readReleaseArtifactTarballs, resolveReleaseArtifactTarball } from "../utils/release-artifacts"

export const execFileAsync = promisify(execFile)
export const repoRoot = resolve(import.meta.dirname, "../..")
export const maxBuffer = 64 * 1024 * 1024

export const consumerNuxt = process.env.VITEHUB_CONSUMER_NUXT === "4.7"
  ? {
      dependencies: { nitro: "3.0.261103-rc", nuxt: "4.7.0" },
      devDependencies: {},
      overrides: { nitro: "3.0.261103-rc", rolldown: "1.2.19", vite: "8.3.8" },
    }
  : {
      dependencies: { nitro: "3.0.261102-rc", nuxt: "npm:nuxt-nightly@5.0.0-2611031025-9496b7e" },
      devDependencies: { "vite-plus": "0.1.24" },
      overrides: { nitro: "3.0.261102-rc", rolldown: "1.2.4", vite: "npm:@voidzero-dev/vite-plus-core@0.1.24" },
    }

const featurePackages: Record<string, string> = { rateLimit: "rate-limit", sandboxTask: "sandbox" }

export async function viteHubPrimitiveIds() {
  const manifest = JSON.parse(await readFile(join(repoRoot, "packages/vite-hub/package.json"), "utf8")) as PackageManifest
  const owners = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
    .filter(name => name.startsWith("@vite-hub/"))
    .map(name => name.slice("@vite-hub/".length))
  return [...new Set([...featureIds.map(id => featurePackages[id] ?? id), ...owners])].sort()
}

export interface PackageManifest {
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

export async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
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

export async function availablePort() {
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

export async function startNodeServer(entry: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code?: number | null, output: string, status?: number }> {
  const port = await availablePort()
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, ...env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", chunk => { output += String(chunk) })
  child.stderr.on("data", chunk => { output += String(chunk) })
  let exit: number | null | undefined
  child.once("exit", (code) => { exit = code })
  try {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (exit !== undefined) return { code: exit, output }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/ping`)
        return { output, status: response.status }
      }
      catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    throw new Error(`The server neither served nor exited:\n${output}`)
  }
  finally {
    child.kill("SIGKILL")
  }
}

export async function withNodeServer<T>(entry: string, cwd: string, callback: (origin: string) => Promise<T>) {
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

export async function withDevServer<T>(command: string, args: string[], cwd: string, ready: RegExp, callback: (origin: string) => Promise<T>, env: NodeJS.ProcessEnv = process.env) {
  const port = await availablePort()
  const child = spawn(command, [...args, "--host", "127.0.0.1", "--port", String(port)], {
    cwd,
    detached: true,
    env: { ...env, NUXT_TELEMETRY_DISABLED: "1" },
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
    await stopProcessGroup(child.pid!)
  }
}

export async function stopProcessGroup(pid: number) {
  signalProcessGroup(pid, "SIGTERM")
  for (let attempt = 0; attempt < 150 && signalProcessGroup(pid, 0); attempt++) {
    if (attempt === 100) signalProcessGroup(pid, "SIGKILL")
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal)
    return true
  }
  catch {
    return false
  }
}

export function packageTarballName(name: string, version: string) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`
}

export function dependencySections(manifest: PackageManifest) {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ].filter((section): section is Record<string, string> => Boolean(section))
}

export function exportTargets(value: string | Record<string, string>) {
  return typeof value === "string" ? [value] : Object.values(value)
}

export function declarationPath(importer: string, specifier: string, files: Set<string>) {
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

export async function assertRootDeclarationsAvoidOptionalPeers(tarball: string, manifest: PackageManifest) {
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

export async function packedManifest(tarball: string) {
  const { stdout } = await run("tar", ["-xOf", tarball, "package/package.json"], repoRoot)
  return JSON.parse(stdout) as PackageManifest
}

export async function assertPackedPackage(tarball: string, framework: boolean) {
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

export async function packWorkspacePackages(packDir: string, packageNames?: Set<string>) {
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

export async function usePackedPeerManifests(appDir: string, specs: Record<string, string>) {
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

export function workspaceConfig(specs: Record<string, string>, additionalOverrides: Record<string, string> = {}) {
  const overrides = Object.entries({
    ...specs,
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
    "  \"@napi-rs/wasm-runtime\": \"1.2.4\"",
    "  \"@emnapi/core\": \"1.9.2\"",
    "  \"@emnapi/runtime\": \"1.9.2\"",
    ...overrides,
    "",
  ].join("\n")
}

export async function installApp(appDir: string, peers: "--strict-peer-dependencies" | "--no-strict-peer-dependencies") {
  await run("pnpm", ["install", "--no-hoist", peers], appDir)
  const lockfile = parseYaml(await readFile(join(appDir, "pnpm-lock.yaml"), "utf8")) as { snapshots?: Record<string, { optional?: boolean }> }
  const fromRegistry = Object.entries(lockfile.snapshots ?? {})
    .filter(([id, snapshot]) => /^(?:vite-hub|@vite-hub\/[^@]+)@\d/.test(id) && !snapshot.optional)
    .map(([id]) => id)
  expect(fromRegistry, "ViteHub packages that pnpm installed from npm instead of a packed tarball").toEqual([])
}
