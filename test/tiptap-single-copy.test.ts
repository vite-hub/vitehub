import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "..")

type Manifest = {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

async function manifest(directory: string): Promise<Manifest> {
  return JSON.parse(await readFile(resolve(repoRoot, "packages", directory, "package.json"), "utf8"))
}

it.each(["realtime", "content"])("@vite-hub/%s takes Tiptap and Yjs from the app", async (directory) => {
  const { dependencies = {}, peerDependencies = {}, peerDependenciesMeta = {} } = await manifest(directory)
  const bundled = new Set(["@tiptap/extension-collaboration", "@tiptap/y-tiptap"])
  const shared = (name: string) => (name.startsWith("@tiptap/") || name === "yjs") && !(directory === "realtime" && bundled.has(name))
  expect(Object.keys(dependencies).filter(shared)).toEqual([])
  expect(Object.keys(peerDependencies).filter(shared)).toContain("@tiptap/core")
  // Content needs Tiptap only for `./editor` and its live room, so an app that does not edit installs none. An optional
  // peer still resolves to the app's copy. Realtime needs Tiptap in every room.
  const optional = Object.keys(peerDependenciesMeta).filter(name => shared(name) && peerDependenciesMeta[name]?.optional).sort()
  expect(optional).toEqual(directory === "content" ? Object.keys(peerDependencies).filter(shared).sort() : [])
})
