#!/usr/bin/env node

import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { gunzipSync } from "node:zlib"

const execFileAsync = promisify(execFile)
const packageNamePattern = /^(?:vite-hub|@vite-hub\/[a-z0-9][a-z0-9._-]*)$/
const shaPattern = /^[0-9a-f]{40}$/
const repository = "https://github.com/vite-hub/vitehub"
const workflowPath = ".github/workflows/release.yml"
const registry = "https://registry.npmjs.org"
const npmRegistry = `${registry}/`
const maxManifestBytes = 2 * 1024 * 1024
const maxPackages = 500
const maxCompressedBytes = 64 * 1024 * 1024
const maxInflatedBytes = 256 * 1024 * 1024
const maxMemberBytes = 64 * 1024 * 1024
const maxMembers = 20_000

function fail(message) {
  throw new Error(message)
}

function assertSourceSha(value) {
  if (!shaPattern.test(value || "")) fail(`Invalid release source SHA: ${value || "(missing)"}`)
}

function assertInside(root, path, label) {
  const fromRoot = relative(resolve(root), resolve(path))
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail(`${label} escapes its root: ${path}`)
  }
}

async function assertPathComponents(root, path, finalType) {
  const absoluteRoot = resolve(root)
  const absolutePath = resolve(path)
  assertInside(absoluteRoot, absolutePath, "Release path")
  const segments = relative(absoluteRoot, absolutePath).split(sep).filter(Boolean)
  let current = absoluteRoot
  const rootStats = await lstat(current)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) fail(`Release root is not a real directory: ${current}`)
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    const stats = await lstat(current)
    if (stats.isSymbolicLink()) fail(`Release path contains a symlink: ${current}`)
    const expected = index === segments.length - 1 ? finalType : "directory"
    if (expected === "directory" && !stats.isDirectory()) fail(`Release path component is not a directory: ${current}`)
    if (expected === "file" && !stats.isFile()) fail(`Release artifact is not a regular file: ${current}`)
  }
}

function workspaceDependencies(manifest, publicNames) {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }
  return Object.keys(dependencies).filter(name => publicNames.has(name)).sort()
}

export async function listReleasePackages(workspace) {
  const root = resolve(workspace)
  const packagesRoot = join(root, "packages")
  const packages = []

  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sourceManifest = `packages/${entry.name}/package.json`
    const path = join(root, sourceManifest)
    let manifest
    try {
      manifest = JSON.parse(await readFile(path, "utf8"))
    }
    catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    if (manifest.private === true) continue
    if (!packageNamePattern.test(manifest.name || "")) fail(`Invalid public package name in ${sourceManifest}`)
    if (typeof manifest.version !== "string" || !manifest.version) fail(`Missing package version in ${sourceManifest}`)
    packages.push({ manifest, name: manifest.name, path, sourceManifest, version: manifest.version })
  }

  const byName = new Map()
  for (const pkg of packages) {
    if (byName.has(pkg.name)) fail(`Duplicate public package name: ${pkg.name}`)
    byName.set(pkg.name, pkg)
  }

  const publicNames = new Set(byName.keys())
  for (const pkg of packages) pkg.workspaceDependencies = workspaceDependencies(pkg.manifest, publicNames)

  const ordered = []
  const visited = new Set()
  const visiting = new Set()
  function visit(pkg) {
    if (visited.has(pkg.name)) return
    if (visiting.has(pkg.name)) fail(`Circular public package dependency at ${pkg.name}`)
    visiting.add(pkg.name)
    for (const dependency of pkg.workspaceDependencies) visit(byName.get(dependency))
    visiting.delete(pkg.name)
    visited.add(pkg.name)
    ordered.push(pkg)
  }

  for (const pkg of packages.toSorted((left, right) => left.name.localeCompare(right.name))) visit(pkg)
  return ordered
}

function tarballName(name, version) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`
}

async function command(runtime, command, args, options = {}) {
  return runtime.exec(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  })
}

function defaultRuntime() {
  return {
    exec: execFileAsync,
    fetch,
    sleep: milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds)),
  }
}

function tarString(block, start, length) {
  const end = block.subarray(start, start + length).indexOf(0)
  return block.subarray(start, start + (end === -1 ? length : end)).toString("utf8")
}

function tarNumber(block, start, length, label) {
  const bytes = block.subarray(start, start + length)
  if ((bytes[0] & 0x80) !== 0) fail(`Tarball uses unsupported base-256 ${label}`)
  const value = bytes.toString("ascii").replaceAll("\0", "").trim()
  if (!/^[0-7]+$/.test(value)) fail(`Tarball has invalid ${label}`)
  return Number.parseInt(value, 8)
}

function isZeroBlock(block) {
  return block.every(byte => byte === 0)
}

function canonicalTarPath(path, directory) {
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.includes("//")) {
    fail(`Tarball has non-canonical member: ${path || "(empty)"}`)
  }
  const segments = path.split("/")
  if (directory && segments.at(-1) === "") segments.pop()
  if (segments.some(segment => !segment || segment === "." || segment === "..")) fail(`Tarball has unsafe member: ${path}`)
  const canonical = segments.join("/")
  if (!(canonical === "package" || canonical.startsWith("package/"))) fail(`Tarball member is outside package/: ${path}`)
  return canonical
}

function parseTarball(bytes, path) {
  if (bytes.byteLength > maxCompressedBytes) fail(`Tarball exceeds ${maxCompressedBytes} compressed bytes: ${path}`)
  let archive
  try {
    archive = gunzipSync(bytes, { maxOutputLength: maxInflatedBytes })
  }
  catch (error) {
    throw new Error(`Invalid or oversized gzip tarball: ${path}`, { cause: error })
  }

  const files = []
  const seen = new Set()
  let packageManifestSource
  let offset = 0
  let members = 0
  let totalMemberBytes = 0
  let terminated = false

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (isZeroBlock(header)) {
      const second = archive.subarray(offset + 512, offset + 1024)
      if (second.length !== 512 || !isZeroBlock(second)) fail(`Tarball has an incomplete end marker: ${path}`)
      if (!archive.subarray(offset + 1024).every(byte => byte === 0)) fail(`Tarball has trailing data: ${path}`)
      terminated = true
      break
    }

    members++
    if (members > maxMembers) fail(`Tarball has more than ${maxMembers} members: ${path}`)
    const storedChecksum = tarNumber(header, 148, 8, "checksum")
    let checksum = 0
    for (let index = 0; index < header.length; index++) checksum += index >= 148 && index < 156 ? 32 : header[index]
    if (checksum !== storedChecksum) fail(`Tarball header checksum mismatch: ${path}`)

    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156])
    if (type !== "0" && type !== "5") fail(`Tarball has unsupported member type ${JSON.stringify(type)}: ${path}`)
    const size = tarNumber(header, 124, 12, "member size")
    if (size > maxMemberBytes) fail(`Tarball member exceeds ${maxMemberBytes} bytes: ${path}`)
    totalMemberBytes += size
    if (totalMemberBytes > maxInflatedBytes) fail(`Tarball members exceed ${maxInflatedBytes} bytes: ${path}`)

    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const memberPath = canonicalTarPath(prefix ? `${prefix}/${name}` : name, type === "5")
    if (seen.has(memberPath)) fail(`Tarball has duplicate member: ${memberPath}`)
    seen.add(memberPath)

    const contentStart = offset + 512
    const contentEnd = contentStart + size
    if (contentEnd > archive.length) fail(`Tarball member exceeds archive bounds: ${memberPath}`)
    if (type === "5") {
      if (size !== 0) fail(`Tarball directory has content: ${memberPath}`)
    }
    else {
      files.push(memberPath)
      if (memberPath === "package/package.json") {
        if (packageManifestSource !== undefined) fail("Tarball has more than one package/package.json")
        packageManifestSource = archive.subarray(contentStart, contentEnd).toString("utf8")
      }
    }
    offset = contentStart + Math.ceil(size / 512) * 512
  }

  if (!terminated) fail(`Tarball has no complete end marker: ${path}`)
  if (packageManifestSource === undefined) fail("Tarball has no package/package.json")
  return { files: files.toSorted(), manifest: JSON.parse(packageManifestSource) }
}

async function tarballDetails(path) {
  const bytes = await readFile(path)
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
  return { ...parseTarball(bytes, path), integrity }
}

function parseManifest(source, path) {
  let manifest
  try {
    manifest = JSON.parse(source)
  }
  catch (error) {
    throw new Error(`Invalid release manifest JSON at ${path}`, { cause: error })
  }
  assertExactKeys(manifest, ["packages", "schemaVersion", "source"], "release manifest")
  assertExactKeys(manifest.source, ["repository", "sha"], "release source")
  if (manifest.schemaVersion !== 1) fail(`Unsupported release manifest schema: ${manifest.schemaVersion}`)
  if (manifest.source?.repository !== repository) fail(`Unexpected release repository: ${manifest.source?.repository}`)
  assertSourceSha(manifest.source?.sha)
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) fail("Release manifest has no packages")
  if (manifest.packages.length > maxPackages) fail(`Release manifest has more than ${maxPackages} packages`)
  return manifest
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Invalid ${label}`)
  const actual = Object.keys(value).toSorted()
  if (JSON.stringify(actual) !== JSON.stringify([...keys].toSorted())) fail(`Unexpected ${label} fields: ${actual.join(", ")}`)
}

function assertSortedUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string")) fail(`Invalid ${label}`)
  if (JSON.stringify(values) !== JSON.stringify([...new Set(values)].toSorted())) fail(`${label} must be sorted and unique`)
}

function assertCanonicalIntegrity(integrity, name) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) fail(`Invalid integrity for ${name}`)
  const encoded = integrity.slice("sha512-".length)
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength !== 64 || bytes.toString("base64") !== encoded) fail(`Non-canonical integrity for ${name}`)
}

export async function readReleaseManifest(manifestPath) {
  const path = resolve(manifestPath)
  const stats = await lstat(path)
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`Release manifest is not a regular file: ${path}`)
  if (stats.size > maxManifestBytes) fail(`Release manifest exceeds ${maxManifestBytes} bytes: ${path}`)
  return { manifest: parseManifest(await readFile(path, "utf8"), path), path }
}

export async function verifyReleaseArtifacts(options) {
  const { manifest, path: manifestPath } = await readReleaseManifest(options.manifestPath)
  assertSourceSha(options.sourceSha)
  if (manifest.source.sha !== options.sourceSha) fail("Release manifest source SHA does not match the expected commit")

  const artifactRoot = dirname(manifestPath)
  const names = new Set()
  const identities = new Set()
  const sourceManifests = new Set()
  const tarballs = new Set()
  const positions = new Map()
  let releaseVersion

  for (const [index, pkg] of manifest.packages.entries()) {
    assertExactKeys(pkg, ["files", "integrity", "name", "sourceManifest", "tarball", "version", "workspaceDependencies"], `release package ${index}`)
    if (!packageNamePattern.test(pkg.name || "")) fail(`Invalid release package name: ${pkg.name}`)
    if (typeof pkg.version !== "string" || !pkg.version) fail(`Invalid release package version for ${pkg.name}`)
    releaseVersion ||= pkg.version
    if (pkg.version !== releaseVersion) fail(`Release packages do not share one version: ${pkg.name}`)
    if (typeof pkg.sourceManifest !== "string" || isAbsolute(pkg.sourceManifest) || pkg.sourceManifest.split("/").includes("..")) {
      fail(`Invalid source manifest path for ${pkg.name}`)
    }
    if (typeof pkg.tarball !== "string" || basename(pkg.tarball) !== pkg.tarball || !pkg.tarball.endsWith(".tgz")) {
      fail(`Invalid tarball path for ${pkg.name}`)
    }
    assertCanonicalIntegrity(pkg.integrity, pkg.name)
    assertSortedUniqueStrings(pkg.files, `File list for ${pkg.name}`)
    assertSortedUniqueStrings(pkg.workspaceDependencies, `Dependency list for ${pkg.name}`)

    const identity = `${pkg.name}@${pkg.version}`
    for (const [set, value, label] of [
      [names, pkg.name, "package name"],
      [identities, identity, "package identity"],
      [sourceManifests, pkg.sourceManifest, "source manifest"],
      [tarballs, pkg.tarball, "tarball"],
    ]) {
      if (set.has(value)) fail(`Duplicate release ${label}: ${value}`)
      set.add(value)
    }
    positions.set(pkg.name, index)
  }

  await assertPathComponents(dirname(artifactRoot), artifactRoot, "directory")
  await assertPathComponents(artifactRoot, manifestPath, "file")
  const artifactEntries = await readdir(artifactRoot, { withFileTypes: true })
  const expectedArtifactFiles = new Set(["release-manifest.json", ...tarballs])
  if (artifactEntries.length !== expectedArtifactFiles.size) fail("Release artifact directory has unlisted entries")
  for (const entry of artifactEntries) {
    if (!expectedArtifactFiles.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      fail(`Unexpected release artifact entry: ${entry.name}`)
    }
  }

  for (const pkg of manifest.packages) {
    const tarballPath = join(artifactRoot, pkg.tarball)
    assertInside(artifactRoot, tarballPath, "Tarball")
    await assertPathComponents(artifactRoot, tarballPath, "file")
    const details = await tarballDetails(tarballPath)
    if (details.integrity !== pkg.integrity) fail(`Tarball integrity mismatch for ${pkg.name}`)
    if (JSON.stringify(details.files) !== JSON.stringify([...pkg.files].toSorted())) fail(`Tarball file list mismatch for ${pkg.name}`)
    if (details.manifest.name !== pkg.name || details.manifest.version !== pkg.version) {
      fail(`Packed manifest identity mismatch for ${pkg.name}`)
    }
    const packedDependencies = workspaceDependencies(details.manifest, names)
    if (JSON.stringify(packedDependencies) !== JSON.stringify([...pkg.workspaceDependencies].toSorted())) {
      fail(`Packed dependency list mismatch for ${pkg.name}`)
    }
    for (const dependency of pkg.workspaceDependencies) {
      if (!positions.has(dependency)) fail(`Missing release dependency ${dependency} for ${pkg.name}`)
      if (positions.get(dependency) >= positions.get(pkg.name)) fail(`${dependency} must precede ${pkg.name}`)
      for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        const specifier = details.manifest[section]?.[dependency]
        if (specifier !== undefined && specifier !== releaseVersion) {
          fail(`Packed ${section} specifier for ${pkg.name} -> ${dependency} is ${specifier}, expected ${releaseVersion}`)
        }
      }
    }
  }

  if (options.workspace) {
    const workspace = resolve(options.workspace)
    const expected = await listReleasePackages(workspace)
    const workspaceVersion = options.workspaceVersion || expected[0]?.version
    if (options.workspaceVersion && manifest.packages.some(pkg => pkg.version !== options.workspaceVersion)) {
      fail(`Release manifest version does not match expected version ${options.workspaceVersion}`)
    }
    if (expected.length !== manifest.packages.length) fail("Release manifest package count does not match the workspace")
    for (const [index, pkg] of manifest.packages.entries()) {
      const owner = expected[index]
      if (!owner || owner.name !== pkg.name || workspaceVersion !== pkg.version || owner.sourceManifest !== pkg.sourceManifest) {
        fail(`Release manifest package order does not match the workspace at index ${index}`)
      }
      if (JSON.stringify(owner.workspaceDependencies) !== JSON.stringify(pkg.workspaceDependencies)) {
        fail(`Release manifest dependencies do not match the workspace for ${pkg.name}`)
      }
    }
  }

  return { artifactRoot, manifest, manifestPath, releaseVersion }
}

export async function createReleaseArtifacts(options) {
  const runtime = options.runtime || defaultRuntime()
  const workspace = resolve(options.workspace)
  const output = resolve(options.output)
  assertSourceSha(options.sourceSha)
  assertInside(workspace, output, "Release output")
  try {
    await lstat(output)
    fail(`Release artifact output already exists: ${output}`)
  }
  catch (error) {
    if (error.code !== "ENOENT") throw error
  }

  await mkdir(dirname(output), { recursive: true })
  await assertPathComponents(workspace, dirname(output), "directory")
  const staging = `${output}.tmp-${process.pid}-${randomUUID()}`
  await mkdir(staging)

  try {
    const packages = await listReleasePackages(workspace)
    const entries = await packReleaseSet(packages, staging, workspace, runtime)

    if (options.verifyReproducible) {
      const reproduction = `${output}.repro-${process.pid}-${randomUUID()}`
      await mkdir(reproduction)
      try {
        await runtime.sleep(options.reproductionDelayMs ?? 1_100)
        const reproduced = await packReleaseSet(packages, reproduction, workspace, runtime)
        for (const [index, entry] of entries.entries()) {
          if (reproduced[index]?.integrity !== entry.integrity || JSON.stringify(reproduced[index]?.files) !== JSON.stringify(entry.files)) {
            fail(`Package tarball is not reproducible: ${entry.name}@${entry.version}`)
          }
        }
      }
      finally {
        await rm(reproduction, { force: true, recursive: true })
      }
    }

    const manifest = {
      schemaVersion: 1,
      source: { repository, sha: options.sourceSha },
      packages: entries,
    }
    const manifestPath = join(staging, "release-manifest.json")
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await verifyReleaseArtifacts({ manifestPath, runtime, sourceSha: options.sourceSha, workspace })
    await rename(staging, output)
    return join(output, "release-manifest.json")
  }
  catch (error) {
    await rm(staging, { force: true, recursive: true })
    throw error
  }
}

async function packReleaseSet(packages, output, workspace, runtime) {
  const entries = []
  for (const pkg of packages) {
    const before = new Set((await readdir(output)).filter(file => file.endsWith(".tgz")))
    await command(runtime, "corepack", ["pnpm", "--filter", pkg.name, "pack", "--pack-destination", output], { cwd: workspace })
    const created = (await readdir(output)).filter(file => file.endsWith(".tgz") && !before.has(file))
    if (created.length !== 1) fail(`${pkg.name} created ${created.length} tarballs instead of one`)
    const expectedName = tarballName(pkg.name, pkg.version)
    if (created[0] !== expectedName) fail(`${pkg.name} created unexpected tarball ${created[0]}`)
    await assertPathComponents(output, join(output, expectedName), "file")
    const details = await tarballDetails(join(output, expectedName))
    if (details.manifest.name !== pkg.name || details.manifest.version !== pkg.version) {
      fail(`Packed manifest identity mismatch for ${pkg.name}`)
    }
    entries.push({
      name: pkg.name,
      version: pkg.version,
      sourceManifest: pkg.sourceManifest,
      tarball: expectedName,
      integrity: details.integrity,
      files: details.files,
      workspaceDependencies: pkg.workspaceDependencies,
    })
  }
  return entries
}

function packagePurl(name, version) {
  return `pkg:npm/${name.replace(/^@/, "%40")}@${version}`
}

function integrityHex(integrity) {
  return Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex")
}

function decodeStatement(attestation) {
  const payload = attestation?.bundle?.dsseEnvelope?.payload
  if (typeof payload !== "string") fail("Registry attestation has no DSSE payload")
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
}

function assertAttestationSubject(statement, pkg) {
  const purl = packagePurl(pkg.name, pkg.version)
  const sha512 = integrityHex(pkg.integrity)
  const subject = statement.subject?.find(entry => entry.name === purl)
  if (subject?.digest?.sha512 !== sha512) fail(`Registry attestation digest mismatch for ${pkg.name}@${pkg.version}`)
}

async function registryFetch(runtime, url, options, label) {
  try {
    return await runtime.fetch(url, { signal: AbortSignal.timeout(options.requestTimeoutMs ?? 15_000) })
  }
  catch (error) {
    throw new Error(`Registry request failed for ${label}`, { cause: error })
  }
}

export async function inspectPublishedPackage(pkg, options) {
  const runtime = options.runtime || defaultRuntime()
  const encodedName = encodeURIComponent(pkg.name)
  const packumentResponse = await registryFetch(runtime, `${registry}/${encodedName}/${encodeURIComponent(pkg.version)}`, options, `${pkg.name}@${pkg.version}`)
  if (packumentResponse.status === 404) return { state: "absent" }
  if (!packumentResponse.ok) fail(`Registry returned ${packumentResponse.status} for ${pkg.name}@${pkg.version}`)
  const packument = await packumentResponse.json()
  if (packument.dist?.integrity !== pkg.integrity) fail(`Registry integrity mismatch for ${pkg.name}@${pkg.version}`)
  const attestationUrl = packument.dist?.attestations?.url
  if (typeof attestationUrl !== "string") fail(`Registry provenance is missing for ${pkg.name}@${pkg.version}`)
  const parsedAttestationUrl = new URL(attestationUrl)
  if (parsedAttestationUrl.origin !== registry || !parsedAttestationUrl.pathname.startsWith("/-/npm/v1/attestations/")) {
    fail(`Registry returned an untrusted attestation URL for ${pkg.name}@${pkg.version}`)
  }

  const rootPackumentResponse = await registryFetch(runtime, `${registry}/${encodedName}`, options, `${pkg.name} dist-tags`)
  if (!rootPackumentResponse.ok) fail(`Registry returned ${rootPackumentResponse.status} for ${pkg.name} dist-tags`)
  const rootPackument = await rootPackumentResponse.json()
  if (rootPackument["dist-tags"]?.[options.tag] !== pkg.version) {
    fail(`Registry dist-tag ${options.tag} does not point to ${pkg.name}@${pkg.version}`)
  }

  const attestationResponse = await registryFetch(runtime, parsedAttestationUrl.href, options, `${pkg.name}@${pkg.version} attestations`)
  if (!attestationResponse.ok) fail(`Registry attestation returned ${attestationResponse.status} for ${pkg.name}@${pkg.version}`)
  const response = await attestationResponse.json()
  const attestations = response.attestations || []
  const publish = attestations.find(entry => entry.predicateType === "https://github.com/npm/attestation/tree/main/specs/publish/v0.1")
  const provenance = attestations.find(entry => entry.predicateType === "https://slsa.dev/provenance/v1")
  if (!publish || !provenance) fail(`Registry attestations are incomplete for ${pkg.name}@${pkg.version}`)

  const publishStatement = decodeStatement(publish)
  const provenanceStatement = decodeStatement(provenance)
  assertAttestationSubject(publishStatement, pkg)
  assertAttestationSubject(provenanceStatement, pkg)
  if (publishStatement.predicate?.name !== pkg.name || publishStatement.predicate?.version !== pkg.version) {
    fail(`Registry publish attestation identity mismatch for ${pkg.name}@${pkg.version}`)
  }
  if (publishStatement.predicate?.registry !== registry) {
    fail(`Registry publish attestation registry mismatch for ${pkg.name}@${pkg.version}`)
  }

  const build = provenanceStatement.predicate?.buildDefinition
  const workflow = build?.externalParameters?.workflow
  const expectedSourceUri = `git+https://github.com/vite-hub/vitehub@${options.sourceRef}`
  const dependency = build?.resolvedDependencies?.find(entry =>
    entry.uri === expectedSourceUri && entry.digest?.gitCommit === options.sourceSha,
  )
  if (workflow?.repository !== repository || workflow?.path !== workflowPath || workflow?.ref !== options.sourceRef || !dependency) {
    fail(`Registry provenance source mismatch for ${pkg.name}@${pkg.version}`)
  }
  return { state: "verified" }
}

async function waitForPublishedPackage(pkg, options) {
  const attempts = options.attempts || 12
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await inspectPublishedPackage(pkg, options)
      if (result.state === "verified") return
    }
    catch (error) {
      lastError = error
    }
    if (attempt < attempts) await options.runtime.sleep(options.retryDelayMs ?? 2_500)
  }
  throw new Error(`Registry did not verify ${pkg.name}@${pkg.version} after ${attempts} attempts`, { cause: lastError })
}

async function auditPublishedSignatures(packages, runtime) {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-release-audit-"))
  try {
    const dependencies = Object.fromEntries(packages.map(pkg => [pkg.name, pkg.version]))
    await writeFile(join(directory, "package.json"), `${JSON.stringify({ dependencies, private: true }, null, 2)}\n`)
    await command(runtime, "npm", ["install", "--package-lock-only", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", `--registry=${npmRegistry}`], { cwd: directory })
    await command(runtime, "npm", ["audit", "signatures", `--registry=${npmRegistry}`], { cwd: directory })
  }
  finally {
    await rm(directory, { force: true, recursive: true })
  }
}

export async function publishReleaseArtifacts(options) {
  const runtime = options.runtime || defaultRuntime()
  const verified = await verifyReleaseArtifacts({
    manifestPath: options.manifestPath,
    runtime,
    sourceSha: options.sourceSha,
  })
  if (!/^[a-z][a-z0-9._-]*$/.test(options.tag || "")) fail(`Invalid npm tag: ${options.tag || "(missing)"}`)
  if (!options.dryRun && options.sourceRef !== `refs/tags/v${verified.releaseVersion}`) {
    fail(`Release source ref must be refs/tags/v${verified.releaseVersion}`)
  }

  const registryStates = []
  if (!options.dryRun) {
    for (const pkg of verified.manifest.packages) {
      registryStates.push(await inspectPublishedPackage(pkg, { ...options, runtime }))
    }
  }

  for (const [index, pkg] of verified.manifest.packages.entries()) {
    const publishArgs = ["publish", `./${pkg.tarball}`, "--access", "public", "--tag", options.tag, "--ignore-scripts", "--no-git-checks", `--registry=${npmRegistry}`]
    if (options.dryRun) {
      publishArgs.push("--dry-run")
      await command(runtime, "npm", publishArgs, { cwd: verified.artifactRoot })
      continue
    }

    const current = registryStates[index]
    if (current.state === "verified") {
      options.onProgress?.(`${pkg.name}@${pkg.version} is already published with matching provenance; skipping.`)
      continue
    }
    publishArgs.push("--provenance")
    try {
      await command(runtime, "npm", publishArgs, { cwd: verified.artifactRoot })
    }
    catch (error) {
      const raced = await inspectPublishedPackage(pkg, { ...options, runtime })
      if (raced.state !== "verified") throw error
      options.onProgress?.(`${pkg.name}@${pkg.version} was published concurrently with matching provenance; continuing.`)
      continue
    }
    await waitForPublishedPackage(pkg, { ...options, runtime })
  }

  if (!options.dryRun) await auditPublishedSignatures(verified.manifest.packages, runtime)
  return verified.manifest.packages.length
}

const commandContracts = {
  files: { allowed: ["manifest"], booleans: [], required: ["manifest"] },
  order: { allowed: ["json", "workspace"], booleans: ["json"], required: [] },
  pack: { allowed: ["output", "source-sha", "verify-reproducible", "workspace"], booleans: ["verify-reproducible"], required: ["output", "source-sha"] },
  publish: { allowed: ["dry-run", "manifest", "source-ref", "source-sha", "tag"], booleans: ["dry-run"], required: ["manifest", "source-sha", "tag"] },
  verify: { allowed: ["manifest", "source-sha", "workspace", "workspace-version"], booleans: [], required: ["manifest", "source-sha"] },
}

function parseArguments(args) {
  const commandName = args.shift()
  const contract = commandContracts[commandName]
  if (!contract) fail(`Unknown command: ${commandName || "(missing)"}`)
  const flags = new Map()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (!flag?.startsWith("--")) fail(`Unexpected argument: ${flag}`)
    const name = flag.slice(2)
    if (!contract.allowed.includes(name)) fail(`Unknown flag for ${commandName}: ${flag}`)
    if (flags.has(name)) fail(`Duplicate flag: ${flag}`)
    if (contract.booleans.includes(name)) {
      flags.set(name, true)
      continue
    }
    const value = args[++index]
    if (!value || value.startsWith("--")) fail(`Missing value for ${flag}`)
    flags.set(name, value)
  }
  for (const required of contract.required) {
    if (!flags.has(required)) fail(`Missing required flag: --${required}`)
  }
  return { commandName, flags }
}

const usage = `Usage:
  node .github/scripts/release-packages.mjs order --workspace <root> [--json]
  node .github/scripts/release-packages.mjs pack --workspace <root> --output <dir> --source-sha <sha> [--verify-reproducible]
  node .github/scripts/release-packages.mjs verify --manifest <file> --source-sha <sha> [--workspace <root>] [--workspace-version <version>]
  node .github/scripts/release-packages.mjs files --manifest <file>
  node .github/scripts/release-packages.mjs publish --manifest <file> --tag <tag> --source-sha <sha> [--source-ref <ref>] [--dry-run]
`

export async function runReleasePackagesCLI(args, output = process, runtime = defaultRuntime()) {
  if (args.length === 0 || args.includes("--help")) {
    output.stdout.write(usage)
    return 0
  }

  let parsed
  try {
    parsed = parseArguments([...args])
  }
  catch (error) {
    output.stderr.write(`${error.message}\n${usage}`)
    return 2
  }

  const { commandName, flags } = parsed
  try {
    if (commandName === "order") {
      const packages = await listReleasePackages(flags.get("workspace") || process.cwd())
      output.stdout.write(flags.get("json")
        ? `${JSON.stringify(packages.map(pkg => ({ name: pkg.name, sourceManifest: pkg.sourceManifest, workspaceDependencies: pkg.workspaceDependencies, version: pkg.version })))}\n`
        : `${packages.map(pkg => pkg.sourceManifest).join("\n")}\n`)
      return 0
    }
    if (commandName === "pack") {
      const manifestPath = await createReleaseArtifacts({
        output: flags.get("output"),
        runtime,
        sourceSha: flags.get("source-sha"),
        verifyReproducible: flags.get("verify-reproducible") === true,
        workspace: flags.get("workspace") || process.cwd(),
      })
      output.stdout.write(`${manifestPath}\n`)
      return 0
    }
    if (commandName === "verify") {
      const result = await verifyReleaseArtifacts({
        manifestPath: flags.get("manifest"),
        runtime,
        sourceSha: flags.get("source-sha"),
        workspace: flags.get("workspace"),
        workspaceVersion: flags.get("workspace-version"),
      })
      output.stdout.write(`Verified ${result.manifest.packages.length} release tarballs.\n`)
      return 0
    }
    if (commandName === "files") {
      const { manifest, path } = await readReleaseManifest(flags.get("manifest"))
      output.stdout.write(`${manifest.packages.map(pkg => join(dirname(path), pkg.tarball)).join("\n")}\n`)
      return 0
    }
    if (commandName === "publish") {
      const count = await publishReleaseArtifacts({
        dryRun: flags.get("dry-run") === true,
        manifestPath: flags.get("manifest"),
        onProgress: message => output.stderr.write(`${message}\n`),
        runtime,
        sourceRef: flags.get("source-ref"),
        sourceSha: flags.get("source-sha"),
        tag: flags.get("tag"),
      })
      output.stdout.write(`${flags.get("dry-run") ? "Dry-ran" : "Published or verified"} ${count} release tarballs.\n`)
      return 0
    }
    output.stderr.write(`Unknown command: ${commandName || "(missing)"}\n${usage}`)
    return 2
  }
  catch (error) {
    output.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runReleasePackagesCLI(process.argv.slice(2))
}
