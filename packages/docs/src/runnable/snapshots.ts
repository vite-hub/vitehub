import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { invariantError } from "@vite-hub/internal/invariant"

import { docsErrorDiagnostics } from "../error-diagnostics.ts"
import { resolveDependencies, workspacePackageDirs } from "./build.ts"

import type { RunnableTutorialSource, WorkspaceVersions } from "./build.ts"

const SNAPSHOT_CONCURRENCY = 3

/** Runs `snapshot-worker.mjs` and returns its stdout. Its warnings, such as an updated lockfile, go to stderr. */
function runSnapshotWorker(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "snapshot-worker.mjs"), ...args], { stdio: ["ignore", "pipe", "inherit"] })
    let stdout = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.once("error", reject)
    child.once("close", code => code === 0 ? resolvePromise(stdout) : reject(new Error(`snapshot-worker.mjs exited with code ${code} for ${args[2]}.`)))
  })
}

/** The parts of a tutorial's snapshot. The app serves them under `/_tutorials/snapshots/`. */
export interface TutorialSnapshot {
  /** The file names of the parts, in order. */
  parts: string[]
  /** The SHA-256 of the joined parts, in hex. */
  sha256: string
}

/** The snapshot of each tutorial, by slug. */
export type TutorialSnapshots = Record<string, TutorialSnapshot>

/** `snapshots.json`: the snapshots, and the hash of the inputs that they were built from. */
interface SnapshotsFile {
  inputs: string
  tutorials: TutorialSnapshots
}

/** The npm lockfile that pins the install of a fixture: `<fixture>.package-lock.json` beside the fixture folder. */
export function tutorialLockfile(fixturesDir: string, fixture: string): string {
  return resolve(fixturesDir, `${fixture}.package-lock.json`)
}

interface Manifest {
  name?: string
  private?: boolean
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  peerDependencies: Record<string, string>
  /** The peers that `peerDependenciesMeta` marks optional. */
  optionalPeers: Set<string>
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const stringRecord = (value: unknown): Record<string, string> =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {}

/** The fields of a `package.json` that a snapshot reads. Other values, and invalid JSON, read as empty. */
export function readManifest(source: string | undefined): Manifest {
  let json: unknown
  try {
    json = source === undefined ? undefined : JSON.parse(source)
  }
  catch {
    json = undefined
  }
  const record = isRecord(json) ? json : {}
  const meta = isRecord(record.peerDependenciesMeta) ? record.peerDependenciesMeta : {}
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    private: record.private === true,
    scripts: stringRecord(record.scripts),
    dependencies: stringRecord(record.dependencies),
    devDependencies: stringRecord(record.devDependencies),
    peerDependencies: stringRecord(record.peerDependencies),
    optionalPeers: new Set(Object.entries(meta).filter(([, value]) => isRecord(value) && value.optional === true).map(([name]) => name)),
  }
}

/**
 * The package that the `dev` script of a fixture runs, when it is in `devDependencies`. A snapshot installs
 * `dependencies` only, so the workspace could not start that dev server.
 */
export function devServerInDevDependencies(manifest: Manifest): string | undefined {
  const command = manifest.scripts.dev?.trim().split(/\s+/)[0]
  return command && command in manifest.devDependencies && !(command in manifest.dependencies) ? command : undefined
}

/** The output line of `snapshot-worker.mjs`. */
function readWorkerResult(stdout: string): { files: string[], sha256: string, bytes: number, compressed: number } {
  const result: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
  if (
    isRecord(result) && Array.isArray(result.files) && result.files.every(file => typeof file === "string")
    && typeof result.sha256 === "string" && typeof result.bytes === "number" && typeof result.compressed === "number"
  ) {
    return { files: result.files, sha256: result.sha256, bytes: result.bytes, compressed: result.compressed }
  }
  throw invariantError(`snapshot-worker.mjs prints its files, hash, and sizes as its last line (${stdout.slice(-200)})`)
}

const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]

/**
 * `pnpm pack` writes the dependencies that had `workspace:` specifiers in a different order on each run. The installed
 * `package.json` would then change the snapshot bytes, so sort those fields and pack the tarball again.
 */
export async function sortPackedManifest(tarball: string, scratch: string): Promise<void> {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  execFileSync("tar", ["-xzf", tarball, "-C", scratch])
  const path = resolve(scratch, "package/package.json")
  const manifest: Record<string, unknown> = JSON.parse(await readFile(path, "utf8"))
  for (const field of dependencyFields) {
    const value = manifest[field]
    if (value && typeof value === "object") manifest[field] = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
  execFileSync("tar", ["-czf", tarball, "-C", scratch, "package"])
  await rm(scratch, { recursive: true, force: true })
}

/**
 * A hash of everything that decides what a snapshot installs: the fixture manifests, the npm lockfiles of the
 * fixtures, and with a pnpm workspace its catalogs, its lockfile, and the manifest of every workspace package. Source
 * code is not in it: a dev server reuses a snapshot with older package code until `TUTORIAL_SNAPSHOTS=1` rebuilds it.
 */
export async function tutorialSnapshotInputs(input: {
  tutorials: RunnableTutorialSource[]
  /** The folder of `pnpm-workspace.yaml`, or nothing when the fixtures install only from npm. */
  workspaceRoot?: string
  fixturesDir: string
  versions: WorkspaceVersions
}): Promise<string> {
  const hash = createHash("sha256")
  const add = (label: string, contents: string) => hash.update(`${label}\0${contents}\0`)
  const read = (path: string) => readFile(path, "utf8").catch(() => "")
  add("versions", JSON.stringify(input.versions))
  for (const tutorial of input.tutorials) {
    add(`${tutorial.slug} fixture`, await read(resolve(input.fixturesDir, tutorial.fixture, "package.json")))
    add(`${tutorial.slug} lockfile`, await read(tutorialLockfile(input.fixturesDir, tutorial.fixture)))
  }
  if (input.workspaceRoot) {
    add("pnpm-lock.yaml", await read(resolve(input.workspaceRoot, "pnpm-lock.yaml")))
    for (const dir of await workspacePackageDirs(input.workspaceRoot)) {
      add(relative(input.workspaceRoot, dir).replaceAll("\\", "/"), await read(resolve(dir, "package.json")))
    }
  }
  return hash.digest("hex")
}

/**
 * Reads the snapshots of the last build when they were built from `inputs`. Removes them, and returns nothing, when
 * snapshots are disabled.
 */
export async function readTutorialSnapshots(outDir: string, options: { inputs: string, disabled?: boolean }): Promise<TutorialSnapshots | undefined> {
  if (options.disabled) {
    await rm(resolve(outDir, "snapshots"), { recursive: true, force: true })
    await rm(resolve(outDir, "snapshots.json"), { force: true })
    return
  }
  const file: Partial<SnapshotsFile> | undefined = await readFile(resolve(outDir, "snapshots.json"), "utf8").then(JSON.parse, () => undefined)
  return file?.inputs === options.inputs ? file.tutorials : undefined
}

/**
 * Builds the `node_modules` snapshot of each tutorial, so its workspace skips `npm install` in the browser.
 *
 * With a pnpm workspace, this builds and packs the workspace packages that each fixture uses, so the snapshot holds
 * the code that the docs describe. It installs them with the other dependencies of the fixture through
 * `createNodeModulesSnapshot` in `snapshot-worker.mjs`, pinned by the npm lockfile beside the fixture, and writes the
 * gzip parts to `<outDir>/snapshots/` with `snapshots.json` beside them. A build that resolves new versions writes the
 * lockfile.
 */
export async function buildTutorialSnapshots(input: {
  tutorials: RunnableTutorialSource[]
  /** The folder of `pnpm-workspace.yaml`, or nothing when the fixtures install only from npm. */
  workspaceRoot?: string
  fixturesDir: string
  versions: WorkspaceVersions
  /** The app serves `<outDir>/snapshots/` at `/_tutorials/snapshots/`. */
  outDir: string
  /** Temporary install folders. */
  workDir: string
}): Promise<TutorialSnapshots> {
  const { workspaceRoot, outDir, workDir } = input
  const workspace = new Map<string, { dir: string, manifest: Manifest }>()
  for (const dir of workspaceRoot ? await workspacePackageDirs(workspaceRoot) : []) {
    const manifest = readManifest(await readFile(resolve(dir, "package.json"), "utf8").catch(() => undefined))
    if (manifest.name) workspace.set(manifest.name, { dir, manifest })
  }
  const closure = (names: string[]): string[] => {
    const seen = new Set<string>()
    const visit = (name: string) => {
      const found = workspace.get(name)
      if (!found || found.manifest.private || seen.has(name)) return
      seen.add(name)
      for (const dependency of Object.keys(found.manifest.dependencies)) visit(dependency)
    }
    names.forEach(visit)
    return [...seen]
  }
  const run = (command: string, args: string[], cwd: string) => execFileSync(command, args, { cwd, stdio: ["ignore", "ignore", "inherit"] })

  const snapshotsDir = resolve(outDir, "snapshots")
  await rm(snapshotsDir, { recursive: true, force: true })
  await mkdir(snapshotsDir, { recursive: true })
  await rm(workDir, { recursive: true, force: true })

  const plans = await Promise.all(input.tutorials.map(async (tutorial) => {
    const source = readManifest(await readFile(resolve(input.fixturesDir, tutorial.fixture, "package.json"), "utf8"))
    const devServer = devServerInDevDependencies(source)
    if (devServer) throw docsErrorDiagnostics.DOCS_RUNNABLE_DEV_SERVER_MISSING({ fixture: tutorial.fixture, name: devServer })
    const local = Object.entries(source.dependencies).filter(([, specifier]) => specifier.startsWith("workspace:")).map(([name]) => name)
    return { tutorial, source, local, packages: closure(local) }
  }))
  // The tutorials share most of their workspace packages, so build and pack each package once for all of them.
  const packed = [...new Set(plans.flatMap(plan => plan.packages))]
  if (workspaceRoot && packed.length > 0) {
    // Include build dependencies (such as the console's CMS), but pack only the runtime closure below.
    const filters = packed.flatMap(name => ["--filter", `${name}...`])
    const vp = resolve(workspaceRoot, "node_modules/.bin/vp")
    if (existsSync(vp)) run(vp, ["run", "--cache", ...filters, "build"], workspaceRoot)
    // `--if-present` packs a package without a build script as it is.
    else run("pnpm", ["--recursive", ...filters, "run", "--if-present", "build"], workspaceRoot)
  }
  const tarballDir = resolve(workDir, "tarballs")
  await mkdir(tarballDir, { recursive: true })
  const tarballFiles = new Map<string, string>()
  for (const name of packed) {
    const before = new Set(await readdir(tarballDir))
    run("pnpm", ["pack", "--pack-destination", tarballDir], workspace.get(name)!.dir)
    const file = (await readdir(tarballDir)).find(candidate => !before.has(candidate))
    if (!file) throw docsErrorDiagnostics.DOCS_RUNNABLE_PACK_FAILED({ name })
    await sortPackedManifest(resolve(tarballDir, file), resolve(workDir, "unpacked"))
    tarballFiles.set(name, file)
  }

  const buildSnapshot = async ({ tutorial, source, local, packages }: typeof plans[number]): Promise<TutorialSnapshot> => {
    const started = performance.now()
    const work = resolve(workDir, tutorial.slug)
    await mkdir(resolve(work, "tarballs"), { recursive: true })
    const tarballs: Record<string, string> = {}
    for (const name of packages) {
      const file = tarballFiles.get(name)!
      await copyFile(resolve(tarballDir, file), resolve(work, "tarballs", file))
      tarballs[name] = `file:./tarballs/${file}`
    }

    // `legacy-peer-deps` installs no peers, so the required peers of the packed packages become dependencies.
    const peers: Record<string, string> = {}
    for (const name of packages) {
      const { peerDependencies, optionalPeers } = workspace.get(name)!.manifest
      for (const [peer, specifier] of Object.entries(peerDependencies)) {
        if (!optionalPeers.has(peer) && !tarballs[peer] && !peer.startsWith("@types/")) peers[peer] = specifier
      }
    }
    const dependencies = resolveDependencies({ ...peers, ...source.dependencies }, input.versions)
    for (const name of local) dependencies[name] = tarballs[name]!
    await writeFile(resolve(work, "package.json"), `${JSON.stringify({ name: source.name, private: true, dependencies, overrides: tarballs }, null, 2)}\n`)
    // npm refuses `overrides` that touch the optional peers of vite-hub.
    await writeFile(resolve(work, ".npmrc"), "legacy-peer-deps=true\n")

    const lockfile = tutorialLockfile(input.fixturesDir, tutorial.fixture)
    const stdout = await runSnapshotWorker([work, snapshotsDir, tutorial.slug, lockfile])
    const written = readWorkerResult(stdout)
    await rm(work, { recursive: true, force: true })
    console.info(`[docs] ${tutorial.slug}: ${(written.bytes / 2 ** 20).toFixed(1)} MiB of node_modules, ${(written.compressed / 2 ** 20).toFixed(1)} MiB in ${written.files.length} parts, sha256 ${written.sha256.slice(0, 12)}, built in ${((performance.now() - started) / 1000).toFixed(0)} s`)
    return { parts: written.files, sha256: written.sha256 }
  }

  // Each snapshot waits on its npm install for most of its time, so a few run at once. Each worker holds its snapshot in memory.
  const results = new Map<string, TutorialSnapshot>()
  const queue = [...plans]
  await Promise.all(Array.from({ length: SNAPSHOT_CONCURRENCY }, async () => {
    for (let plan = queue.shift(); plan; plan = queue.shift()) results.set(plan.tutorial.slug, await buildSnapshot(plan))
  }))
  await rm(workDir, { recursive: true, force: true })
  const snapshots: TutorialSnapshots = Object.fromEntries(plans.map(plan => [plan.tutorial.slug, results.get(plan.tutorial.slug)!]))
  // After the build, which can update the lockfiles.
  const file: SnapshotsFile = { inputs: await tutorialSnapshotInputs(input), tutorials: snapshots }
  await writeFile(resolve(outDir, "snapshots.json"), `${JSON.stringify(file, null, 2)}\n`)
  return snapshots
}
