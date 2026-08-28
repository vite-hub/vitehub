import { execFile, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { gzipSync } from "node:zlib"

import { afterEach, describe, expect, it } from "vitest"

import {
  createReleaseArtifacts,
  inspectPublishedPackage,
  listReleasePackages,
  publishReleaseArtifacts,
  runReleasePackagesCLI,
  verifyReleaseArtifacts,
} from "../.github/scripts/release-packages.mjs"
import { readReleaseArtifactTarballs, resolveReleaseArtifactTarball } from "./utils/release-artifacts"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const scriptPath = resolve(repoRoot, ".github/scripts/release-packages.mjs")
const sourceSha = "a".repeat(40)
const sourceRef = "refs/tags/v1.2.3"
const temporaryDirectories: string[] = []

interface FixturePackage {
  dependencies?: string[]
  files?: Array<{ content: string, path: string, type?: string }>
  name: string
  version?: string
}

interface ReleaseEntry {
  files: string[]
  integrity: string
  name: string
  sourceManifest: string
  tarball: string
  version: string
  workspaceDependencies: string[]
}

async function temporaryDirectory(name: string) {
  const directory = await mkdtemp(join(tmpdir(), name))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

function writeTarString(header: Buffer, offset: number, length: number, value: string) {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8")
}

function writeTarNumber(header: Buffer, offset: number, length: number, value: number) {
  const encoded = value.toString(8).padStart(length - 1, "0")
  header.write(`${encoded}\0`, offset, length, "ascii")
}

function tarEntry(path: string, content: string, type = "0") {
  const body = Buffer.from(content)
  const header = Buffer.alloc(512)
  writeTarString(header, 0, 100, path)
  writeTarNumber(header, 100, 8, 0o644)
  writeTarNumber(header, 108, 8, 0)
  writeTarNumber(header, 116, 8, 0)
  writeTarNumber(header, 124, 12, type === "0" ? body.length : 0)
  writeTarNumber(header, 136, 12, 0)
  header.fill(32, 148, 156)
  header.write(type, 156, 1, "ascii")
  writeTarString(header, 257, 6, "ustar")
  writeTarString(header, 263, 2, "00")
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)])
}

function tarball(entries: Array<{ content: string, path: string, type?: string }>) {
  return gzipSync(Buffer.concat([
    ...entries.map(entry => tarEntry(entry.path, entry.content, entry.type)),
    Buffer.alloc(1024),
  ]), { level: 9 })
}

function packageJson(pkg: FixturePackage) {
  return JSON.stringify({
    dependencies: Object.fromEntries((pkg.dependencies || []).map(name => [name, pkg.version || "1.2.3"])),
    name: pkg.name,
    version: pkg.version || "1.2.3",
  })
}

function packageTarballName(name: string, version: string) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`
}

async function writeArtifact(root: string, packages: FixturePackage[]) {
  const artifactRoot = join(root, "artifacts")
  await mkdir(artifactRoot, { recursive: true })
  const entries: ReleaseEntry[] = []
  for (const [index, pkg] of packages.entries()) {
    const version = pkg.version || "1.2.3"
    const members = pkg.files || [
      { content: packageJson(pkg), path: "package/package.json" },
      { content: `export const packageIndex = ${index}\n`, path: "package/dist/index.js" },
    ]
    const bytes = tarball(members)
    const name = packageTarballName(pkg.name, version)
    await writeFile(join(artifactRoot, name), bytes)
    entries.push({
      files: [...new Set(members.filter(member => (member.type || "0") === "0").map(member => member.path))].toSorted(),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      name: pkg.name,
      sourceManifest: `packages/${pkg.name.split("/").at(-1)}/package.json`,
      tarball: name,
      version,
      workspaceDependencies: [...(pkg.dependencies || [])].toSorted(),
    })
  }
  const manifest = { packages: entries, schemaVersion: 1, source: { repository: "https://github.com/vite-hub/vitehub", sha: sourceSha } }
  const manifestPath = join(artifactRoot, "release-manifest.json")
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { artifactRoot, manifest, manifestPath }
}

async function rewriteManifest(manifestPath: string, change: (manifest: any) => void) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  change(manifest)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

async function replaceTarball(manifestPath: string, packageIndex: number, bytes: Buffer, files?: string[]) {
  const manifest = await rewriteManifest(manifestPath, (value) => {
    value.packages[packageIndex].integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    if (files) value.packages[packageIndex].files = files.toSorted()
  })
  await writeFile(join(dirname(manifestPath), manifest.packages[packageIndex].tarball), bytes)
}

async function writeWorkspace(root: string, packages: FixturePackage[]) {
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.33.0", private: true }))
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
  for (const pkg of packages) {
    const directory = join(root, "packages", pkg.name.split("/").at(-1)!)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "index.js"), `export default ${JSON.stringify(pkg.name)}\n`)
    await writeFile(join(directory, "package.json"), `${JSON.stringify({
      dependencies: Object.fromEntries((pkg.dependencies || []).map(name => [name, pkg.version || "1.2.3"])),
      files: ["index.js", "package.json"],
      name: pkg.name,
      version: pkg.version || "1.2.3",
    }, null, 2)}\n`)
  }
}

function response(status: number, body?: unknown) {
  return { json: async () => body, ok: status >= 200 && status < 300, status }
}

function statement(predicateType: string, pkg: ReleaseEntry, predicate: unknown) {
  const subject = [{
    digest: { sha512: Buffer.from(pkg.integrity.slice("sha512-".length), "base64").toString("hex") },
    name: `pkg:npm/${pkg.name.replace(/^@/, "%40")}@${pkg.version}`,
  }]
  return {
    bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify({ predicate, predicateType, subject })).toString("base64url") } },
    predicateType,
  }
}

function verifiedRegistryEntry(pkg: ReleaseEntry, tag = "latest") {
  const attestations = [
    statement("https://github.com/npm/attestation/tree/main/specs/publish/v0.1", pkg, {
      name: pkg.name,
      registry: "https://registry.npmjs.org",
      version: pkg.version,
    }),
    statement("https://slsa.dev/provenance/v1", pkg, {
      buildDefinition: {
        externalParameters: { workflow: { path: ".github/workflows/release.yml", ref: sourceRef, repository: "https://github.com/vite-hub/vitehub" } },
        resolvedDependencies: [{
          digest: { gitCommit: sourceSha },
          uri: `git+https://github.com/vite-hub/vitehub@${sourceRef}`,
        }],
      },
    }),
  ]
  return { attestations, integrity: pkg.integrity, tag, version: pkg.version }
}

function fakeRegistryRuntime(packages: ReleaseEntry[], initial = new Map<string, ReturnType<typeof verifiedRegistryEntry>>()) {
  const state = initial
  const distTags = new Map([...initial].map(([name, entry]) => [name, { tag: entry.tag, version: entry.version }]))
  const calls: Array<{ args: string[], command: string, cwd?: string, timeout?: number }> = []
  const events: string[] = []
  const incompleteReads = new Map<string, number>()
  let failPublish: string | undefined
  let failAudit = false
  let sleeps = 0
  const byTarball = new Map(packages.map(pkg => [pkg.tarball, pkg]))
  const runtime = {
    exec: async (command: string, args: string[], options: { cwd?: string, timeout?: number } = {}) => {
      calls.push({ args: [...args], command, cwd: options.cwd, timeout: options.timeout })
      if (command === "npm" && args[0] === "audit") {
        events.push("audit")
        if (failAudit) throw new Error("signature audit failed")
      }
      if (command === "npm" && args[0] === "publish" && !args.includes("--dry-run")) {
        const pkg = byTarball.get(args[1]!.slice(2))!
        if (pkg.name === failPublish) throw new Error(`publish failed for ${pkg.name}`)
        const tag = args[args.indexOf("--tag") + 1]!
        state.set(pkg.name, verifiedRegistryEntry(pkg, tag))
        distTags.set(pkg.name, { tag, version: pkg.version })
      }
      return { stderr: "", stdout: "" }
    },
    fetch: async (input: string) => {
      const url = new URL(input)
      for (const pkg of packages) {
        const encoded = encodeURIComponent(pkg.name)
        const entry = state.get(pkg.name)
        if (url.href === `https://registry.npmjs.org/${encoded}/${pkg.version}`) {
          const remaining = incompleteReads.get(pkg.name) || 0
          if (entry && remaining > 0) {
            incompleteReads.set(pkg.name, remaining - 1)
            return response(404)
          }
          return entry
            ? response(200, { dist: { attestations: { url: `https://registry.npmjs.org/-/npm/v1/attestations/${encoded}@${pkg.version}` }, integrity: entry.integrity } })
            : response(404)
        }
        if (url.href === `https://registry.npmjs.org/${encoded}`) {
          const tagged = distTags.get(pkg.name)
          return response(200, { "dist-tags": tagged ? { [tagged.tag]: tagged.version } : {} })
        }
        if (url.href === `https://registry.npmjs.org/-/npm/v1/attestations/${encoded}@${pkg.version}`) {
          if (entry) events.push(`verified:${pkg.name}`)
          return response(200, { attestations: entry?.attestations || [] })
        }
      }
      throw new Error(`Unexpected registry request: ${url.href}`)
    },
    sleep: async () => { sleeps++ },
  }
  return {
    calls,
    events,
    getSleeps: () => sleeps,
    runtime,
    setFailAudit: (value = true) => { failAudit = value },
    setFailPublish: (name?: string) => { failPublish = name },
    setDistTag: (name: string, tag: string, version: string) => distTags.set(name, { tag, version }),
    setIncompleteReads: (name: string, count: number) => incompleteReads.set(name, count),
    state,
  }
}

describe("release package artifacts", () => {
  it("packs twice, produces canonical stable bytes, and verifies the workspace graph", async () => {
    const root = await temporaryDirectory("vitehub-release-pack-")
    await writeWorkspace(root, [
      { name: "@vite-hub/runtime" },
      { dependencies: ["@vite-hub/runtime"], name: "@vite-hub/app" },
    ])

    const manifestPath = await createReleaseArtifacts({
      output: join(root, ".release/npm"),
      reproductionDelayMs: 1,
      sourceSha,
      verifyReproducible: true,
      workspace: root,
    })
    const source = await readFile(manifestPath, "utf8")
    const manifest = JSON.parse(source)

    expect(source).toBe(`${JSON.stringify(manifest, null, 2)}\n`)
    expect(manifest.packages.map((pkg: ReleaseEntry) => pkg.name)).toEqual(["@vite-hub/runtime", "@vite-hub/app"])
    expect(manifest.packages[1].workspaceDependencies).toEqual(["@vite-hub/runtime"])
    await expect(verifyReleaseArtifacts({ manifestPath, sourceSha, workspace: root })).resolves.toMatchObject({ releaseVersion: "1.2.3" })
  }, 30_000)

  it("rejects pre-existing and symlinked outputs", async () => {
    const root = await temporaryDirectory("vitehub-release-output-")
    await writeWorkspace(root, [{ name: "@vite-hub/runtime" }])
    const existing = join(root, "existing")
    await mkdir(existing)
    await expect(createReleaseArtifacts({ output: existing, sourceSha, workspace: root })).rejects.toThrow("already exists")

    const target = join(root, "target")
    const link = join(root, "link")
    await mkdir(target)
    await symlink(target, link, "dir")
    await expect(createReleaseArtifacts({ output: link, sourceSha, workspace: root })).rejects.toThrow("already exists")
  })

  it("removes owned staging after a pack command failure", async () => {
    const root = await temporaryDirectory("vitehub-release-pack-failure-")
    await writeWorkspace(root, [{ name: "@vite-hub/runtime" }])
    const output = join(root, ".release/npm")
    const runtime = {
      exec: async () => { throw new Error("pack failed") },
      fetch,
      sleep: async () => {},
    }

    await expect(createReleaseArtifacts({ output, runtime, sourceSha, workspace: root })).rejects.toThrow("pack failed")
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await readdir(dirname(output))).filter(name => name.startsWith("npm.tmp-"))).toEqual([])
  })

  it("excludes private packages from the ordered release set", async () => {
    const root = await temporaryDirectory("vitehub-release-graph-")
    await writeWorkspace(root, [
      { name: "@vite-hub/a" },
      { name: "@vite-hub/private" },
    ])
    const privatePath = join(root, "packages/private/package.json")
    const privateManifest = JSON.parse(await readFile(privatePath, "utf8"))
    privateManifest.private = true
    await writeFile(privatePath, JSON.stringify(privateManifest))
    await expect(listReleasePackages(root)).resolves.toMatchObject([{ name: "@vite-hub/a" }])
  })

  it("rejects a public package dependency cycle", async () => {
    const root = await temporaryDirectory("vitehub-release-cycle-")
    await writeWorkspace(root, [
      { dependencies: ["@vite-hub/b"], name: "@vite-hub/a" },
      { dependencies: ["@vite-hub/a"], name: "@vite-hub/b" },
    ])
    await expect(listReleasePackages(root)).rejects.toThrow("Circular public package dependency")
  })

  it.each([
    ["missing member", [{ content: packageJson({ name: "@vite-hub/runtime" }), path: "package/package.json" }]],
    ["extra member", [
      { content: packageJson({ name: "@vite-hub/runtime" }), path: "package/package.json" },
      { content: "ok", path: "package/dist/index.js" },
      { content: "extra", path: "package/extra.js" },
    ]],
    ["duplicate member", [
      { content: packageJson({ name: "@vite-hub/runtime" }), path: "package/package.json" },
      { content: "one", path: "package/dist/index.js" },
      { content: "two", path: "package/dist/index.js" },
    ]],
    ["symlink member", [
      { content: packageJson({ name: "@vite-hub/runtime" }), path: "package/package.json" },
      { content: "", path: "package/dist/index.js", type: "2" },
    ]],
    ["absolute member", [
      { content: packageJson({ name: "@vite-hub/runtime" }), path: "package/package.json" },
      { content: "bad", path: "/package/dist/index.js" },
    ]],
    ["parent traversal member", [
      { content: packageJson({ name: "@vite-hub/runtime" }), path: "package/package.json" },
      { content: "bad", path: "package/../escape.js" },
    ]],
  ])("rejects an actual tar archive with a %s", async (_name, members) => {
    const root = await temporaryDirectory("vitehub-release-tar-")
    const artifact = await writeArtifact(root, [{ name: "@vite-hub/runtime" }])
    const bytes = tarball(members)
    await replaceTarball(artifact.manifestPath, 0, bytes)
    await expect(verifyReleaseArtifacts({ manifestPath: artifact.manifestPath, sourceSha })).rejects.toThrow(/Tarball|tarball/)
  })

  it("rejects corrupt gzip, missing and extra tarballs, and symlinked tarballs", async () => {
    const root = await temporaryDirectory("vitehub-release-files-")
    const corrupt = await writeArtifact(join(root, "corrupt"), [{ name: "@vite-hub/runtime" }])
    await replaceTarball(corrupt.manifestPath, 0, Buffer.from("not gzip"))
    await expect(verifyReleaseArtifacts({ manifestPath: corrupt.manifestPath, sourceSha })).rejects.toThrow("Invalid or oversized gzip")

    const missing = await writeArtifact(join(root, "missing"), [{ name: "@vite-hub/runtime" }])
    await unlink(join(missing.artifactRoot, missing.manifest.packages[0].tarball))
    await expect(verifyReleaseArtifacts({ manifestPath: missing.manifestPath, sourceSha })).rejects.toThrow("unlisted entries")

    const extra = await writeArtifact(join(root, "extra"), [{ name: "@vite-hub/runtime" }])
    await writeFile(join(extra.artifactRoot, "extra.tgz"), "extra")
    await expect(verifyReleaseArtifacts({ manifestPath: extra.manifestPath, sourceSha })).rejects.toThrow("unlisted entries")

    const linked = await writeArtifact(join(root, "linked"), [{ name: "@vite-hub/runtime" }])
    const packagePath = join(linked.artifactRoot, linked.manifest.packages[0].tarball)
    const target = join(root, "target.tgz")
    await cp(packagePath, target)
    await unlink(packagePath)
    await symlink(target, packagePath)
    await expect(verifyReleaseArtifacts({ manifestPath: linked.manifestPath, sourceSha })).rejects.toThrow("Unexpected release artifact entry")
  })

  it("rejects symlinked and oversized manifests before parsing", async () => {
    const root = await temporaryDirectory("vitehub-release-manifest-file-")
    const artifact = await writeArtifact(root, [{ name: "@vite-hub/runtime" }])
    const linkedManifest = join(root, "linked-manifest.json")
    await symlink(artifact.manifestPath, linkedManifest)
    await expect(verifyReleaseArtifacts({ manifestPath: linkedManifest, sourceSha })).rejects.toThrow("not a regular file")

    const oversizedManifest = join(root, "oversized-manifest.json")
    await writeFile(oversizedManifest, Buffer.alloc(2 * 1024 * 1024 + 1))
    await expect(verifyReleaseArtifacts({ manifestPath: oversizedManifest, sourceSha })).rejects.toThrow("exceeds")
  })

  it("rejects manifest tampering, duplicates, and workspace package or graph drift", async () => {
    const root = await temporaryDirectory("vitehub-release-manifest-")
    const packages = [
      { name: "@vite-hub/runtime" },
      { dependencies: ["@vite-hub/runtime"], name: "@vite-hub/zapp" },
    ]
    await writeWorkspace(root, packages)
    const baseline = await writeArtifact(root, packages)

    const duplicate = join(root, "duplicate")
    await cp(baseline.artifactRoot, duplicate, { recursive: true })
    await rewriteManifest(join(duplicate, "release-manifest.json"), value => value.packages.push(value.packages[0]))
    await expect(verifyReleaseArtifacts({ manifestPath: join(duplicate, "release-manifest.json"), sourceSha })).rejects.toThrow("Duplicate")

    const reordered = join(root, "reordered")
    await cp(baseline.artifactRoot, reordered, { recursive: true })
    await rewriteManifest(join(reordered, "release-manifest.json"), value => value.packages.reverse())
    await expect(verifyReleaseArtifacts({ manifestPath: join(reordered, "release-manifest.json"), sourceSha })).rejects.toThrow("must precede")

    const missing = join(root, "missing-package")
    await cp(baseline.artifactRoot, missing, { recursive: true })
    await rewriteManifest(join(missing, "release-manifest.json"), value => value.packages.pop())
    await unlink(join(missing, baseline.manifest.packages[1].tarball))
    await expect(verifyReleaseArtifacts({ manifestPath: join(missing, "release-manifest.json"), sourceSha, workspace: root })).rejects.toThrow("package count")

    const driftedWorkspace = await temporaryDirectory("vitehub-release-drifted-")
    await cp(join(root, "package.json"), join(driftedWorkspace, "package.json"))
    await cp(join(root, "pnpm-workspace.yaml"), join(driftedWorkspace, "pnpm-workspace.yaml"))
    await cp(join(root, "packages"), join(driftedWorkspace, "packages"), { recursive: true })
    const appManifestPath = join(driftedWorkspace, "packages/zapp/package.json")
    const appManifest = JSON.parse(await readFile(appManifestPath, "utf8"))
    delete appManifest.dependencies
    await writeFile(appManifestPath, JSON.stringify(appManifest))
    await expect(verifyReleaseArtifacts({ manifestPath: baseline.manifestPath, sourceSha, workspace: driftedWorkspace })).rejects.toThrow("dependencies do not match")

    const extraWorkspace = await temporaryDirectory("vitehub-release-extra-")
    await writeWorkspace(extraWorkspace, [...packages, { name: "@vite-hub/extra" }])
    await expect(verifyReleaseArtifacts({ manifestPath: baseline.manifestPath, sourceSha, workspace: extraWorkspace })).rejects.toThrow("package count")
  })

  it.each([
    ["integrity", (value: any) => { value.packages[0].integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}` }],
    ["files", (value: any) => { value.packages[0].files = ["package/missing.js", "package/package.json"] }],
    ["dependency list", (value: any) => { value.packages[1].workspaceDependencies = [] }],
    ["source SHA", (value: any) => { value.source.sha = "b".repeat(40) }],
    ["source path escape", (value: any) => { value.packages[0].sourceManifest = "../package.json" }],
    ["tarball path escape", (value: any) => { value.packages[0].tarball = "../package.tgz" }],
    ["duplicate name", (value: any) => { value.packages[1].name = value.packages[0].name }],
    ["duplicate source manifest", (value: any) => { value.packages[1].sourceManifest = value.packages[0].sourceManifest }],
    ["duplicate tarball", (value: any) => { value.packages[1].tarball = value.packages[0].tarball }],
  ])("rejects %s manifest tampering", async (_name, mutate) => {
    const root = await temporaryDirectory("vitehub-release-tamper-")
    const artifact = await writeArtifact(root, [
      { name: "@vite-hub/runtime" },
      { dependencies: ["@vite-hub/runtime"], name: "@vite-hub/app" },
    ])
    await rewriteManifest(artifact.manifestPath, mutate)
    await expect(verifyReleaseArtifacts({ manifestPath: artifact.manifestPath, sourceSha })).rejects.toThrow()
  })

  it.each([
    ["name", { name: "@vite-hub/forged", version: "1.2.3" }],
    ["version", { name: "@vite-hub/runtime", version: "9.9.9" }],
  ])("rejects packed %s substitution", async (_field, identity) => {
    const root = await temporaryDirectory("vitehub-release-packed-identity-")
    const artifact = await writeArtifact(root, [{ name: "@vite-hub/runtime" }])
    const members = [
      { content: packageJson(identity), path: "package/package.json" },
      { content: "forged", path: "package/dist/index.js" },
    ]
    const bytes = tarball(members)
    await replaceTarball(artifact.manifestPath, 0, bytes, members.map(member => member.path))
    await expect(verifyReleaseArtifacts({ manifestPath: artifact.manifestPath, sourceSha })).rejects.toThrow("Packed manifest identity mismatch")
  })

  it("reuses every exact manifest tarball without invoking the pack fallback", async () => {
    const root = await temporaryDirectory("vitehub-release-reuse-")
    const artifact = await writeArtifact(root, [
      { name: "@vite-hub/runtime" },
      { name: "@vite-hub/app" },
    ])
    const previous = process.env.VITEHUB_RELEASE_MANIFEST
    process.env.VITEHUB_RELEASE_MANIFEST = artifact.manifestPath
    try {
      const releaseTarballs = readReleaseArtifactTarballs(root)
      const pack = async () => { throw new Error("pnpm pack must not run") }
      for (const pkg of artifact.manifest.packages) {
        expect(resolveReleaseArtifactTarball(releaseTarballs, pkg.name, pack)).toBe(join(artifact.artifactRoot, pkg.tarball))
      }
      expect(releaseTarballs?.size).toBe(artifact.manifest.packages.length)
    }
    finally {
      if (previous === undefined) delete process.env.VITEHUB_RELEASE_MANIFEST
      else process.env.VITEHUB_RELEASE_MANIFEST = previous
    }
  })

  it("compares trusted source membership using the release version override", async () => {
    const root = await temporaryDirectory("vitehub-release-trusted-source-")
    const packages = [{ name: "@vite-hub/runtime", version: "1.2.3" }]
    const artifact = await writeArtifact(root, packages)
    const trusted = await temporaryDirectory("vitehub-release-trusted-workspace-")
    await writeWorkspace(trusted, [{ name: "@vite-hub/runtime", version: "0.0.1" }])

    await expect(verifyReleaseArtifacts({
      manifestPath: artifact.manifestPath,
      sourceSha,
      workspace: trusted,
      workspaceVersion: "1.2.3",
    })).resolves.toMatchObject({ releaseVersion: "1.2.3" })
    await expect(verifyReleaseArtifacts({ manifestPath: artifact.manifestPath, sourceSha, workspace: trusted }))
      .rejects.toThrow("package order does not match")
  })
})

describe("release publication", () => {
  it("rejects an invalid artifact set before any registry or npm call", async () => {
    const root = await temporaryDirectory("vitehub-release-invalid-publish-")
    const artifact = await writeArtifact(root, [{ name: "@vite-hub/runtime" }])
    await rewriteManifest(artifact.manifestPath, value => {
      value.packages[0].integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`
    })
    let execCalls = 0
    let fetchCalls = 0
    const runtime = {
      exec: async () => { execCalls++; return { stderr: "", stdout: "" } },
      fetch: async () => { fetchCalls++; return response(500) },
      sleep: async () => {},
    }

    await expect(publishReleaseArtifacts({ manifestPath: artifact.manifestPath, runtime, sourceRef, sourceSha, tag: "latest" }))
      .rejects.toThrow("Tarball integrity mismatch")
    expect({ execCalls, fetchCalls }).toEqual({ execCalls: 0, fetchCalls: 0 })
  })

  it("dry-runs only exact manifest tarballs in order and makes no registry request", async () => {
    const root = await temporaryDirectory("vitehub-release-dry-run-")
    const artifact = await writeArtifact(root, [
      { name: "@vite-hub/runtime" },
      { dependencies: ["@vite-hub/runtime"], name: "@vite-hub/app" },
    ])
    const registry = fakeRegistryRuntime(artifact.manifest.packages)
    let fetches = 0
    const runtime = { ...registry.runtime, fetch: async (...args: Parameters<typeof fetch>) => { fetches++; return registry.runtime.fetch(String(args[0])) } }

    await publishReleaseArtifacts({ dryRun: true, manifestPath: artifact.manifestPath, runtime, sourceSha, tag: "latest" })

    expect(fetches).toBe(0)
    expect(registry.calls.every(call => call.timeout === 120_000)).toBe(true)
    expect(registry.calls.map(call => [call.command, call.args])).toEqual(artifact.manifest.packages.map((pkg: ReleaseEntry) => [
      "npm",
      ["publish", `./${pkg.tarball}`, "--access", "public", "--tag", "latest", "--ignore-scripts", "--no-git-checks", "--registry=https://registry.npmjs.org/", "--dry-run"],
    ]))
  })

  it("preflights the full registry before mutation", async () => {
    const root = await temporaryDirectory("vitehub-release-preflight-")
    const artifact = await writeArtifact(root, [
      { name: "@vite-hub/runtime" },
      { dependencies: ["@vite-hub/runtime"], name: "@vite-hub/app" },
    ])
    const bad = verifiedRegistryEntry(artifact.manifest.packages[1])
    bad.integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`
    const registry = fakeRegistryRuntime(artifact.manifest.packages, new Map([[artifact.manifest.packages[1].name, bad]]))

    await expect(publishReleaseArtifacts({ manifestPath: artifact.manifestPath, runtime: registry.runtime, sourceRef, sourceSha, tag: "latest" }))
      .rejects.toThrow("Registry integrity mismatch")
    expect(registry.calls).toEqual([])
  })

  it.each([
    ["latest", "1.2.4"],
    ["alpha", "1.2.3-alpha.2"],
    ["beta", "1.2.3-beta.2"],
    ["rc", "1.2.3-rc.2"],
    ["next", "1.2.3-preview.2"],
  ])("rejects a stale queued %s release before mutation", async (tag, newerVersion) => {
    const root = await temporaryDirectory("vitehub-release-stale-tag-")
    const candidateVersion = tag === "latest" ? "1.2.3" : `1.2.3-${tag === "next" ? "preview" : tag}.1`
    const artifact = await writeArtifact(root, [
      { name: "@vite-hub/runtime", version: candidateVersion },
      { name: "@vite-hub/app", version: candidateVersion },
    ])
    const registry = fakeRegistryRuntime(artifact.manifest.packages)
    registry.setDistTag("@vite-hub/app", tag, newerVersion)

    await expect(publishReleaseArtifacts({
      manifestPath: artifact.manifestPath,
      runtime: registry.runtime,
      sourceRef: `refs/tags/v${candidateVersion}`,
      sourceSha,
      tag,
    })).rejects.toThrow(`already points to newer @vite-hub/app@${newerVersion}`)
    expect(registry.calls).toEqual([])
    expect(registry.state).toEqual(new Map())
  })

  it("stops after a publish failure and resumes from verified registry state", async () => {
    const root = await temporaryDirectory("vitehub-release-resume-")
    const artifact = await writeArtifact(root, [
      { name: "@vite-hub/runtime" },
      { dependencies: ["@vite-hub/runtime"], name: "@vite-hub/app" },
      { dependencies: ["@vite-hub/app"], name: "@vite-hub/final" },
    ])
    const registry = fakeRegistryRuntime(artifact.manifest.packages)
    registry.setFailPublish("@vite-hub/app")

    await expect(publishReleaseArtifacts({ attempts: 1, manifestPath: artifact.manifestPath, runtime: registry.runtime, sourceRef, sourceSha, tag: "latest" }))
      .rejects.toThrow("publish failed")
    expect(registry.calls.filter(call => call.args[0] === "publish").map(call => call.args[1])).toEqual([
      `./${artifact.manifest.packages[0].tarball}`,
      `./${artifact.manifest.packages[1].tarball}`,
    ])

    registry.setFailPublish()
    registry.calls.splice(0)
    await publishReleaseArtifacts({ attempts: 1, manifestPath: artifact.manifestPath, runtime: registry.runtime, sourceRef, sourceSha, tag: "latest" })
    expect(registry.calls.filter(call => call.args[0] === "publish").map(call => call.args[1])).toEqual([
      `./${artifact.manifest.packages[1].tarball}`,
      `./${artifact.manifest.packages[2].tarball}`,
    ])
    expect(registry.calls.some(call => call.args[0] === "audit" && call.args[1] === "signatures")).toBe(true)
    expect(registry.calls.every(call => call.args.includes("--registry=https://registry.npmjs.org/"))).toBe(true)
  })

  it("retries registry propagation before auditing the fully verified set", async () => {
    const root = await temporaryDirectory("vitehub-release-propagation-")
    const artifact = await writeArtifact(root, [{ name: "@vite-hub/runtime" }])
    const registry = fakeRegistryRuntime(artifact.manifest.packages)
    registry.setIncompleteReads("@vite-hub/runtime", 2)

    await publishReleaseArtifacts({ attempts: 3, manifestPath: artifact.manifestPath, runtime: registry.runtime, sourceRef, sourceSha, tag: "latest" })

    expect(registry.getSleeps()).toBe(2)
    expect(registry.events).toEqual(["verified:@vite-hub/runtime", "audit"])
  })

  it("reports exhausted propagation and signature audit failures", async () => {
    const propagationRoot = await temporaryDirectory("vitehub-release-propagation-failure-")
    const propagation = await writeArtifact(propagationRoot, [{ name: "@vite-hub/runtime" }])
    const delayed = fakeRegistryRuntime(propagation.manifest.packages)
    delayed.setIncompleteReads("@vite-hub/runtime", 2)
    await expect(publishReleaseArtifacts({ attempts: 2, manifestPath: propagation.manifestPath, runtime: delayed.runtime, sourceRef, sourceSha, tag: "latest" }))
      .rejects.toThrow("Registry did not verify @vite-hub/runtime@1.2.3 after 2 attempts")
    expect(delayed.events).not.toContain("audit")

    const auditRoot = await temporaryDirectory("vitehub-release-audit-failure-")
    const audit = await writeArtifact(auditRoot, [{ name: "@vite-hub/runtime" }])
    const registry = fakeRegistryRuntime(audit.manifest.packages)
    registry.setFailAudit()
    await expect(publishReleaseArtifacts({ attempts: 1, manifestPath: audit.manifestPath, runtime: registry.runtime, sourceRef, sourceSha, tag: "latest" }))
      .rejects.toThrow("signature audit failed")
    expect(registry.events).toEqual(["verified:@vite-hub/runtime", "audit"])
  })

  it("bounds a registry request that never settles", async () => {
    const root = await temporaryDirectory("vitehub-release-timeout-")
    const artifact = await writeArtifact(root, [{ name: "@vite-hub/runtime" }])
    const never = (_input: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })

    await expect(inspectPublishedPackage(artifact.manifest.packages[0], {
      requestTimeoutMs: 5,
      runtime: { exec: execFileAsync, fetch: never, sleep: async () => {} },
      sourceRef,
      sourceSha,
      tag: "latest",
    })).rejects.toThrow("Registry request failed")
  })

  it.each([
    ["publish registry", (entry: ReturnType<typeof verifiedRegistryEntry>, pkg: ReleaseEntry) => {
      entry.attestations[0] = statement("https://github.com/npm/attestation/tree/main/specs/publish/v0.1", pkg, { name: pkg.name, registry: "https://registry.example.invalid", version: pkg.version })
    }],
    ["provenance URI", (entry: ReturnType<typeof verifiedRegistryEntry>, pkg: ReleaseEntry) => {
      entry.attestations[1] = statement("https://slsa.dev/provenance/v1", pkg, { buildDefinition: { externalParameters: { workflow: { path: ".github/workflows/release.yml", ref: sourceRef, repository: "https://github.com/vite-hub/vitehub" } }, resolvedDependencies: [{ digest: { gitCommit: sourceSha }, uri: "git+https://example.invalid/forged" }] } })
    }],
  ])("rejects mismatched %s attestation", async (_name, mutate) => {
    const root = await temporaryDirectory("vitehub-release-provenance-")
    const artifact = await writeArtifact(root, [{ name: "@vite-hub/runtime" }])
    const pkg = artifact.manifest.packages[0]
    const entry = verifiedRegistryEntry(pkg)
    mutate(entry, pkg)
    const registry = fakeRegistryRuntime(artifact.manifest.packages, new Map([[pkg.name, entry]]))
    await expect(inspectPublishedPackage(pkg, { runtime: registry.runtime, sourceRef, sourceSha, tag: "latest" })).rejects.toThrow()
  })
})

describe("release package CLI", () => {
  it.each([
    ["unknown flag", ["files", "--manifest", "manifest.json", "--wat"]],
    ["duplicate flag", ["files", "--manifest", "a", "--manifest", "b"]],
    ["missing required flag", ["verify", "--manifest", "manifest.json"]],
    ["unknown command", ["unknown"]],
  ])("returns usage status 2 for an %s", async (_name, args) => {
    const stdout: string[] = []
    const stderr: string[] = []
    const status = await runReleasePackagesCLI(args, {
      stderr: { write: (value: string) => { stderr.push(value) } },
      stdout: { write: (value: string) => { stdout.push(value) } },
    })
    expect(status).toBe(2)
    expect(stdout).toEqual([])
    expect(stderr.join("")).toContain("Usage:")
  })

  it("runs the real executable help contract", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" })
    expect(result).toMatchObject({ status: 0, stderr: "" })
    expect(result.stdout).toContain("release-packages.mjs pack")
  })

  it("returns operational status 1 and successful status 0", async () => {
    const output = { stderr: { write: () => {} }, stdout: { write: () => {} } }
    await expect(runReleasePackagesCLI(["files", "--manifest", "/missing/release-manifest.json"], output)).resolves.toBe(1)
    const root = await temporaryDirectory("vitehub-release-cli-")
    const artifact = await writeArtifact(root, [{ name: "@vite-hub/runtime" }])
    await expect(runReleasePackagesCLI(["files", "--manifest", artifact.manifestPath], output)).resolves.toBe(0)
  })
})
