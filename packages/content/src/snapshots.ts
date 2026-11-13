import type { ComarkContent, ContentFile, Manifest, ParsedSource, Source as ComarkContentSource } from "comark-content"

import type { StoredCommit } from "./commit-cache.ts"

/**
 * Build-time snapshots of read-only Content Sources. A ViteHub build parses each `glob()` or `files()` Source once and
 * ships the parsed documents in the server bundle, so a cold server reads them instead of parsing every Markdown file
 * on its first Content request. `vite dev` keeps parsing live.
 *
 * A snapshot is an index and body shards. The index holds the Source keys, Comark's manifest (every document without
 * its body), and the shard of each document. `list()` and `navigation()` read only the index, `get()` reads one shard,
 * and a full load, such as the first search, reads every shard.
 *
 * A `github()` Source gets a commit snapshot instead: the commit that the build resolved for its branch, in the format of
 * the commit cache. Its index names the commit and its one shard holds the commit. The commit cache reads it when the
 * head is that commit, so a cold server downloads no archive.
 */

/** The index of a snapshot. */
export interface ContentSnapshotIndex {
  /** The keys of the Source definition the snapshot was parsed from. A Source with other keys parses again. */
  keys: string[]
  manifest: Manifest
  /** The shard of each document, by its key in the Source. */
  shards: Record<string, number>
}

/** The index of a commit snapshot of a `github()` Source. */
export interface ContentCommitSnapshotIndex {
  commit: {
    sha: string
    ref: string | null
    /** The Source fingerprint, as the head stores it. A Source with another repository or ref ignores the snapshot. */
    origin: string
  }
}

/**
 * One Content instance's snapshot: the index, and a loader for each shard of parsed documents. Each is JSON text,
 * gzipped and in base64. A server compiles that short string at start, and Cloudflare Workers compile every module of
 * the bundle when an isolate starts, so the snapshot costs startup by its gzip size, not its JSON size.
 */
export interface ContentSnapshot {
  index: string
  shards: Array<() => Promise<string>>
}

/** Loads the snapshot of one Content instance. */
export type ContentSnapshotLoader = () => Promise<ContentSnapshot>

export interface ContentSnapshotTarget {
  name: string
  instance: ComarkContent
  /** The keys of the instance's Source definition. */
  keys: () => Promise<string[]>
  /**
   * For a `github()` Source: resolve and parse the commit of its branch. Undefined without a GitHub token, and a string
   * that says why when the commit does not load or parse.
   */
  commit?: () => Promise<BuiltContentCommit | string | undefined>
}

/** The commit of a `github()` Source that the build parsed. `json` is the text of `commitJson()`. */
export interface BuiltContentCommit {
  sha: string
  ref: string | null
  origin: string
  json: string
}

/** A commit snapshot as the commit cache reads it. `read()` loads and inflates the commit. */
export interface ContentCommitSnapshot {
  sha: string
  ref: string | null
  origin: string
  read: () => Promise<StoredCommit>
}

/** Bodies per shard, in JSON characters. A `get()` on a cold server parses one shard of about this size. */
const SHARD_SIZE = 512 * 1024

let registered: Record<string, ContentSnapshotLoader> | undefined
const targets = new WeakMap<object, ContentSnapshotTarget[]>()

/**
 * Give the next `defineContent()` call the snapshots of its Sources, by instance name. The ViteHub build calls it at the
 * top of `server/content.ts`; you do not call it yourself. An instance uses its snapshot only when its Source is a
 * `files()` Source with the same keys, which is what a build makes of `glob()`.
 */
export function registerContentSnapshots(loaders: Record<string, ContentSnapshotLoader>): void {
  registered = loaders
}

/** The snapshots registered for this `defineContent()` call. Later calls get none. */
export function takeContentSnapshots(): Record<string, ContentSnapshotLoader> | undefined {
  const loaders = registered
  registered = undefined
  return loaders
}

/** Remember which instances of a Content runtime the build may snapshot. */
export function setContentSnapshotTargets(runtime: object, list: ContentSnapshotTarget[]): void {
  targets.set(runtime, list)
}

/** JSON text gzipped in base64, as the build writes it into the bundle. */
export async function readSnapshotJson<T>(base64: string): Promise<T> {
  // Node, Bun, Deno, and Workers with nodejs_compat have node:zlib and node:buffer. On Node they decode about 5 times faster than atob() and DecompressionStream.
  const zlib = globalThis.process?.getBuiltinModule?.("node:zlib")
  const buffer = globalThis.process?.getBuiltinModule?.("node:buffer")
  if (zlib && buffer) return JSON.parse(zlib.gunzipSync(buffer.Buffer.from(base64, "base64")).toString()) as T
  // A loop, because Uint8Array.from() with a map function takes about 75 ms for 1.5 MB of base64.
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return await new Response(new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"))).json() as T
}

function sameKeys(left: string[], right: string[]): boolean {
  const a = left.slice().sort()
  const b = right.slice().sort()
  return a.length === b.length && a.every((key, index) => key === b[index])
}

/**
 * A Comark parsed Source that reads the build-time snapshot and keeps `origin` as its raw Source, so `refresh()` parses
 * the origin again. `keys` lists the keys of the Source definition without reading files. When the snapshot holds
 * other keys, every loader returns null and Comark parses the origin, as it would without a snapshot.
 */
export function withContentSnapshot(origin: ComarkContentSource, load: ContentSnapshotLoader, keys: () => Promise<string[]>): ParsedSource {
  let opened: Promise<{ index: ContentSnapshotIndex, shard: (index: number) => Promise<ContentFile[]> } | null> | undefined
  const open = () => opened ??= (async () => {
    const snapshot = await load()
    const [index, sourceKeys] = await Promise.all([readSnapshotJson<ContentSnapshotIndex>(snapshot.index), keys()])
    if (!sameKeys(index.keys, sourceKeys)) return null
    const shards = new Map<number, Promise<ContentFile[]>>()
    const shard = (number: number) => {
      let items = shards.get(number)
      if (!items) {
        items = snapshot.shards[number]!().then(text => readSnapshotJson<ContentFile[]>(text)).catch((error: unknown) => {
          shards.delete(number)
          throw error
        })
        shards.set(number, items)
      }
      return items
    }
    return { index, shard }
  })().catch((error: unknown) => {
    // A failed load lets the next read try again.
    opened = undefined
    throw error
  })
  return {
    parsed: true,
    origin,
    ...(origin.schema ? { schema: origin.schema } : {}),
    async manifest() {
      return (await open())?.index.manifest
    },
    async get(key) {
      const snapshot = await open()
      const number = snapshot?.index.shards[key]
      if (!snapshot || number === undefined) return
      return (await snapshot.shard(number)).find(item => item.meta.key.slice(item.meta.key.indexOf("/") + 1) === key)
    },
    async snapshot() {
      const snapshot = await open()
      if (!snapshot) return
      const shards = await Promise.all([...new Set(Object.values(snapshot.index.shards))].map(snapshot.shard))
      return { items: shards.flat(), time: snapshot.index.manifest.time }
    },
  }
}

/**
 * Open the commit snapshot of a `github()` Source once. Only the index inflates here. The commit loads on `read()`, so a
 * server whose head moved past the build commit never loads it. Undefined for a snapshot that is not a commit snapshot.
 */
export function openCommitSnapshot(load: ContentSnapshotLoader): () => Promise<ContentCommitSnapshot | undefined> {
  let opened: Promise<ContentCommitSnapshot | undefined> | undefined
  return () => opened ??= (async () => {
    const snapshot = await load()
    const { commit } = await readSnapshotJson<Partial<ContentCommitSnapshotIndex>>(snapshot.index)
    const shard = snapshot.shards[0]
    if (!commit || !shard) return
    return { ...commit, read: async () => await readSnapshotJson<StoredCommit>(await shard()) }
  })()
}

/** The JSON text of one instance's snapshot: its index and its shards. */
export interface BuiltContentSnapshot {
  index: string
  shards: string[]
}

/**
 * Parse every read-only `glob()` or `files()` Source of a Content runtime, as the build does, and the branch commit of
 * each `github()` Source when the build has a GitHub token. Returns each snapshot by instance name, and why an instance
 * has none. A `github()` Source without a token has no snapshot and no warning: the server loads it as it would anyway.
 */
export async function buildContentSnapshots(runtime: object): Promise<{ snapshots: Record<string, BuiltContentSnapshot>, skipped: Record<string, string> }> {
  const snapshots: Record<string, BuiltContentSnapshot> = {}
  const skipped: Record<string, string> = {}
  for (const { name, instance, keys: sourceKeys, commit } of targets.get(runtime) ?? []) {
    if (commit) {
      try {
        const built = await commit()
        if (typeof built === "string") skipped[name] = built
        else if (built) {
          const index: ContentCommitSnapshotIndex = { commit: { sha: built.sha, ref: built.ref, origin: built.origin } }
          snapshots[name] = { index: JSON.stringify(index), shards: [built.json] }
        }
      }
      catch (error) {
        skipped[name] = error instanceof Error ? error.message : String(error)
      }
      continue
    }
    const { hooks } = instance
    const callHook = hooks.callHook
    // Index plugins, such as `sql-query`, build their tables from `file:bulk:load`. The build only parses, so they do not
    // write to the app's Database here. They get the parsed documents when the server loads the snapshot.
    hooks.callHook = ((hook: string, ...args: unknown[]) => hook === "file:bulk:load" ? Promise.resolve() : Reflect.apply(callHook, hooks, [hook, ...args])) as typeof callHook
    try {
      await instance.init({ partial: false, ignoreCache: true })
      const keys = await sourceKeys()
      const { items } = await instance.snapshot()
      const shards: string[] = []
      const shardOf: Record<string, number> = {}
      let shard: string[] = []
      let size = 0
      for (const item of items) {
        const json = JSON.stringify(item)
        if (shard.length && size + json.length > SHARD_SIZE) {
          shards.push(`[${shard.join(",")}]`)
          shard = []
          size = 0
        }
        shard.push(json)
        size += json.length
        shardOf[item.meta.key.slice(name.length + 1)] = shards.length
      }
      if (shard.length) shards.push(`[${shard.join(",")}]`)
      const index: ContentSnapshotIndex = { keys, manifest: await instance.manifest(), shards: shardOf }
      snapshots[name] = { index: JSON.stringify(index), shards }
    }
    catch (error) {
      skipped[name] = error instanceof Error ? error.message : String(error)
    }
    finally {
      hooks.callHook = callHook
    }
  }
  return { snapshots, skipped }
}
