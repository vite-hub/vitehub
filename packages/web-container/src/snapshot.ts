import { execFile } from "node:child_process"
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { gzipSync } from "node:zlib"
import { encode } from "@msgpack/msgpack"

import { snapshotLinksFile, type SnapshotLinks } from "./links.ts"
import { aliasName, lockedAliases, sameRecord, withoutAliases, withoutTarballIntegrity } from "./lockfile.ts"
import { readTree } from "./tree.ts"

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
  /** A folder with the `package.json` (and `.npmrc`) of the app. The install writes `node_modules` here and preserves `package.json`. */
  dir: string
  /** Keep `devDependencies`. @default false */
  dev?: boolean
  /**
   * The `lockfile` of an earlier snapshot of this app. The install then runs `npm ci`, so the same lockfile gives the
   * same `node_modules` and the same snapshot bytes. Without it, npm resolves the versions and returns a new lockfile.
   */
  lockfile?: string
  /**
   * With `false`, a `lockfile` that no longer matches the app is updated with `npm install`, which keeps the versions it
   * can, instead of an error. @default true
   */
  frozenLockfile?: boolean
}

export interface NodeModulesSnapshot {
  /** The binary snapshot for `bootWebContainer({ snapshot })`. */
  snapshot: Uint8Array
  /** The `package-lock.json` of the install. Keep it and pass it back as `lockfile` to get the same snapshot. */
  lockfile: string
}

/** A supplied lockfile is out of sync with the app's dependencies or required wasm aliases. */
export class SnapshotLockfileMismatchError extends Error {
  override name = "SnapshotLockfileMismatchError"
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
export async function createNodeModulesSnapshot(options: CreateNodeModulesSnapshotOptions): Promise<NodeModulesSnapshot> {
  if (process.platform === "win32") throw new Error("createNodeModulesSnapshot requires a POSIX host (Linux, macOS, or WSL).")
  const { dir } = options
  const modules = join(dir, "node_modules")
  const manifestPath = join(dir, "package.json")
  const lockPath = join(dir, "package-lock.json")
  const originalManifest = await readFile(manifestPath)
  const manifest: Manifest = JSON.parse(originalManifest.toString("utf8"))
  const frozen = options.lockfile !== undefined && options.frozenLockfile !== false
  let aliases = options.lockfile === undefined ? {} : lockedAliases(options.lockfile)
  try {
    if (options.lockfile !== undefined) await writeFile(lockPath, options.lockfile)
    else await rm(lockPath, { force: true })

    // The wasm builds have the versions of the packages they replace, which the install decides. When it decides other
    // versions than the aliases have, install again with the new aliases. A second round always agrees.
    for (let round = 0; ; round++) {
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, dependencies: { ...withoutAliases(manifest.dependencies), ...aliases } }, null, 2)}\n`)
      await rm(modules, { recursive: true, force: true })
      try {
        await run("npm", [frozen ? "ci" : "install", "--cpu=wasm32", ...options.dev ? [] : ["--omit=dev"], ...npmFlags], { cwd: dir, maxBuffer: 64 * 2 ** 20 })
      }
      catch (error) {
        // EUSAGE alone also covers unrelated npm usage errors. Only its explicit sync diagnostic permits an update.
        if (frozen && error instanceof Error && "stderr" in error && typeof error.stderr === "string"
          && error.stderr.includes("code EUSAGE")
          && error.stderr.includes("`npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.")) {
          throw new SnapshotLockfileMismatchError("The lockfile does not match the app. Pass frozenLockfile: false to update it.", { cause: error })
        }
        throw error
      }
      const needed = await neededAliases(modules)
      if (sameRecord(needed, aliases)) break
      if (frozen) throw new SnapshotLockfileMismatchError("The lockfile does not match the app: its wasm builds have other versions. Pass frozenLockfile: false to update it.")
      if (round > 1) throw new Error("The wasm builds of the app do not settle on one set of versions.")
      aliases = needed
    }

    for (const { name, path } of await packageDirs(modules)) {
      const wasm = wasmBuilds[name]
      const target = wasm ?? wasmBindings[name]
      if (!target) continue
      const alias = join(modules, aliasName(target, await packageVersion(path)))
      // A wasm build takes the place of the package. A binding goes into the package's own node_modules.
      const destination = wasm ? path : join(path, "node_modules", target)
      if (wasm) await rm(path, { recursive: true, force: true })
      await cp(alias, destination, { recursive: true, verbatimSymlinks: true })
    }
    for (const alias of Object.keys(aliases)) await rm(join(modules, alias), { recursive: true, force: true })

    const links: SnapshotLinks = { links: [], executables: [] }
    const tree = await readTree(dir, modules, links)
    tree[snapshotLinksFile] = { f: { c: new TextEncoder().encode(JSON.stringify(links)) } }
    return { snapshot: encode({ d: { node_modules: { d: tree } } }), lockfile: withoutTarballIntegrity(await readFile(lockPath, "utf8")) }
  }
  finally {
    await writeFile(manifestPath, originalManifest)
  }
}

interface Manifest {
  dependencies?: Record<string, string>
  [field: string]: unknown
}



/** An alias for each wasm build or binding that the installed packages need, such as `npm:esbuild-wasm@0.28.2`. */
async function neededAliases(modules: string): Promise<Record<string, string>> {
  const needed: Record<string, string> = {}
  for (const { name, path } of await packageDirs(modules)) {
    const target = wasmBuilds[name] ?? wasmBindings[name]
    if (!target) continue
    const version = await packageVersion(path)
    needed[aliasName(target, version)] = `npm:${target}@${version}`
  }
  return needed
}


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

async function packageVersion(path: string): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(join(path, "package.json"), "utf8"))
  const version = manifest && typeof manifest === "object" && "version" in manifest ? manifest.version : undefined
  if (typeof version !== "string") throw new Error(`${path}/package.json has no version.`)
  return version
}

/** Every package folder below `modules`, with its name. `nested` also walks the node_modules of each package. */
async function packageDirs(modules: string, nested = true): Promise<{ name: string, path: string }[]> {
  const found: { name: string, path: string }[] = []
  const entries = await readdir(modules, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return []
    throw error
  })
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
