import type { ComarkContent, ContentFile, Manifest, ParsedSource, Source as ComarkContentSource } from "comark-content"

/**
 * Build-time snapshots of read-only Content Sources. A ViteHub build parses each `glob()` or `files()` Source once and
 * ships the parsed documents in the server bundle, so a cold server reads them instead of parsing every Markdown file
 * on its first Content request. `vite dev` keeps parsing live.
 *
 * A snapshot is an index and body shards. The index holds the Source keys, Comark's manifest (every document without
 * its body), and the shard of each document. `list()` and `navigation()` read only the index, `get()` reads one shard,
 * and a full load, such as the first search, reads every shard.
 */

/** The index of a snapshot, as JSON text in the bundle. */
export interface ContentSnapshotIndex {
  /** The Source keys the snapshot was parsed from. A Source with other keys parses again. */
  keys: string[]
  manifest: Manifest
  /** The shard of each document, by its key in the Source. */
  shards: Record<string, number>
}

/** One Content instance's snapshot: the index, and a loader for each shard of parsed documents. Both are JSON text. */
export interface ContentSnapshot {
  index: string
  shards: Array<() => Promise<string>>
}

/** Loads the snapshot of one Content instance. */
export type ContentSnapshotLoader = () => Promise<ContentSnapshot>

export interface ContentSnapshotTarget {
  name: string
  instance: ComarkContent
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

function sameKeys(left: string[], right: string[]): boolean {
  const a = left.slice().sort()
  const b = right.slice().sort()
  return a.length === b.length && a.every((key, index) => key === b[index])
}

/**
 * A Comark parsed Source that reads the build-time snapshot and keeps `origin` as its raw Source, so `refresh()` parses
 * the origin again. When the snapshot holds other keys than the origin, every loader returns null and Comark parses
 * the origin, as it would without a snapshot.
 */
export function withContentSnapshot(origin: ComarkContentSource, load: ContentSnapshotLoader): ParsedSource {
  let opened: Promise<{ index: ContentSnapshotIndex, shard: (index: number) => Promise<ContentFile[]> } | null> | undefined
  const open = () => opened ??= (async () => {
    const snapshot = await load()
    const index: ContentSnapshotIndex = JSON.parse(snapshot.index)
    if (!sameKeys(index.keys, await origin.keys())) return null
    const shards = new Map<number, Promise<ContentFile[]>>()
    const shard = (number: number) => {
      let items = shards.get(number)
      if (!items) {
        items = snapshot.shards[number]!().then(text => JSON.parse(text) as ContentFile[])
        shards.set(number, items)
      }
      return items
    }
    return { index, shard }
  })()
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

/** The JSON text of one instance's snapshot: its index and its shards. */
export interface BuiltContentSnapshot {
  index: string
  shards: string[]
}

/**
 * Parse every read-only `glob()` or `files()` Source of a Content runtime, as the build does. Returns each snapshot by
 * instance name, and why an instance has none.
 */
export async function buildContentSnapshots(runtime: object): Promise<{ snapshots: Record<string, BuiltContentSnapshot>, skipped: Record<string, string> }> {
  const snapshots: Record<string, BuiltContentSnapshot> = {}
  const skipped: Record<string, string> = {}
  for (const { name, instance } of targets.get(runtime) ?? []) {
    const { hooks } = instance
    const callHook = hooks.callHook
    // Index plugins, such as `sql-query`, build their tables from `file:bulk:load`. The build only parses, so they do not
    // write to the app's Database here. They get the parsed documents when the server loads the snapshot.
    hooks.callHook = ((hook: string, ...args: unknown[]) => hook === "file:bulk:load" ? Promise.resolve() : Reflect.apply(callHook, hooks, [hook, ...args])) as typeof callHook
    try {
      await instance.init({ partial: false, ignoreCache: true })
      const keys = await instance.getSource(name)!.keys()
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
