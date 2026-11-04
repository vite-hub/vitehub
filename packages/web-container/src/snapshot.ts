import { execFile } from "node:child_process"
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { promisify } from "node:util"
import { gzipSync } from "node:zlib"
import { encode } from "@msgpack/msgpack"

import { snapshotLinksFile, type SnapshotLinks } from "./links.ts"

const run = promisify(execFile)
const npmFlags = ["--ignore-scripts", "--no-audit", "--no-fund", "--no-progress"]

/**
 * Packages that npm in a WebContainer replaces with their wasm build of the same version.
 * A probe of `npm install` in a WebContainer shows the swap: `node_modules/esbuild` holds `esbuild-wasm`.
 */
const wasmBuilds: Record<string, string> = {
  "esbuild": "esbuild-wasm",
  "lightningcss": "lightningcss-wasm",
  "@libsql/client": "@libsql/client-wasm",
}
/** rolldown is not swapped. In a WebContainer it installs this binding into `/tmp` on first use, which takes seconds. */
const wasmBindings: Record<string, string> = {
  rolldown: "@rolldown/binding-wasm32-wasi",
}

export interface CreateNodeModulesSnapshotOptions {
  /** A folder with the `package.json` (and `.npmrc`) of the app. The install writes `node_modules` here. */
  dir: string
  /** Keep `devDependencies`. @default false */
  dev?: boolean
}

/**
 * Installs the dependencies of an app on this machine as npm in a WebContainer does, and returns a snapshot that holds
 * only `node_modules`. Mount it with `bootWebContainer({ snapshot })`, so the container skips `npm install`.
 *
 * Native binaries are left out: the install uses `--cpu=wasm32`, swaps packages for their wasm builds, and adds the
 * wasm binding of rolldown. Install scripts do not run. Source maps are dropped.
 * The snapshot cannot hold symlinks or executable bits, so it lists them, and `bootWebContainer` restores them.
 * Creation requires a POSIX host (Linux, macOS, or WSL); Windows npm shims cannot be restored as POSIX bin links.
 */
export async function createNodeModulesSnapshot(options: CreateNodeModulesSnapshotOptions): Promise<Uint8Array> {
  if (process.platform === "win32") throw new Error("createNodeModulesSnapshot requires a POSIX host (Linux, macOS, or WSL).")
  const { dir } = options
  const modules = join(dir, "node_modules")
  await rm(modules, { recursive: true, force: true })
  await run("npm", ["install", "--cpu=wasm32", ...options.dev ? [] : ["--omit=dev"], ...npmFlags], { cwd: dir, maxBuffer: 64 * 2 ** 20 })

  const side = join(dir, ".wasm-builds")
  for (const { name, path } of await packageDirs(modules)) {
    const wasm = wasmBuilds[name]
    const target = wasm ?? wasmBindings[name]
    if (!target) continue
    const version = await packageVersion(path)
    const installed = await installAlone(join(side, `${target.replace("/", "+")}@${version}`), `${target}@${version}`)
    // A wasm build takes the place of the package. A binding goes into the package's own node_modules.
    const destination = wasm ? path : join(path, "node_modules", target)
    if (wasm) await rm(path, { recursive: true, force: true })
    await cp(join(installed, target), destination, { recursive: true })
    for (const dependency of await packageDirs(installed, false)) {
      if (dependency.name !== target) await cp(dependency.path, join(destination, "node_modules", dependency.name), { recursive: true })
    }
  }
  await rm(side, { recursive: true, force: true })

  const links: SnapshotLinks = { links: [], executables: [] }
  const tree = await readTree(dir, modules, links)
  tree[snapshotLinksFile] = { f: { c: new TextEncoder().encode(JSON.stringify(links)) } }
  return encode({ d: { node_modules: { d: tree } } })
}

/** The binary snapshot format that `WebContainer#mount()` reads: msgpack of `{ d: { [name]: { d } | { f: { c } } } }`. */
type SnapshotTree = Record<string, { d: SnapshotTree } | { f: { c: Uint8Array } }>

/**
 * Compresses a snapshot with gzip and splits it into parts of at most `partBytes`, for hosts that limit the size of a
 * static file, such as the 25 MiB of Cloudflare Workers assets. `fetchSnapshot` joins the parts again.
 */
export function packSnapshot(data: Uint8Array, options: { partBytes?: number } = {}): Uint8Array[] {
  const partBytes = options.partBytes ?? 20 * 2 ** 20
  if (!Number.isSafeInteger(partBytes) || partBytes <= 0) throw new RangeError("partBytes must be a positive safe integer.")
  const compressed = gzipSync(data, { level: 9 })
  const parts: Uint8Array[] = []
  for (let offset = 0; offset < compressed.byteLength; offset += partBytes) parts.push(compressed.subarray(offset, offset + partBytes))
  return parts
}

async function installAlone(dir: string, spec: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), "{}\n")
  // `--force`: the rolldown binding declares no cpu, but npm still checks its engines.
  await run("npm", ["install", spec, "--force", "--no-package-lock", ...npmFlags], { cwd: dir, maxBuffer: 64 * 2 ** 20 })
  return join(dir, "node_modules")
}

async function packageVersion(path: string): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(join(path, "package.json"), "utf8"))
  const version = manifest && typeof manifest === "object" && "version" in manifest ? manifest.version : undefined
  if (typeof version !== "string") throw new Error(`${path}/package.json has no version.`)
  return version
}

/** Every package folder below `modules`, with its name. `nested` also walks the node_modules of each package. */
async function packageDirs(modules: string, nested = true): Promise<{ name: string, path: string }[]> {
  const found: { name: string, path: string }[] = []
  const entries = await readdir(modules, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const path = join(modules, entry.name)
    const packages = entry.name.startsWith("@")
      ? (await readdir(path, { withFileTypes: true })).filter(scoped => scoped.isDirectory()).map(scoped => ({ name: `${entry.name}/${scoped.name}`, path: join(path, scoped.name) }))
      : [{ name: entry.name, path }]
    for (const item of packages) {
      found.push(item)
      if (nested) found.push(...await packageDirs(join(item.path, "node_modules")))
    }
  }
  return found
}

/** Reads `dir` into a snapshot tree, one file at a time. Symlinks and executable files go into `links`, relative to `root`. Source maps are left out. */
async function readTree(root: string, dir: string, links: SnapshotLinks): Promise<SnapshotTree> {
  const tree: SnapshotTree = {}
  // Sorted, so the same files give the same bytes and the same content hash on every build.
  for (const entry of (await readdir(dir)).sort()) {
    const path = join(dir, entry)
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) links.links.push([relative(root, path), await readlink(path)])
    else if (stats.isDirectory()) tree[entry] = { d: await readTree(root, path, links) }
    else if (stats.isFile() && !entry.endsWith(".map")) {
      if (stats.mode & 0o111) links.executables.push(relative(root, path))
      tree[entry] = { f: { c: await readFile(path) } }
    }
  }
  return tree
}
