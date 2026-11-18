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

// The editor of `useRealtimeTiptap()` goes into the app's Tiptap components, such as Nuxt UI's editor. Tiptap packages
// depend on one exact @tiptap/core version, so a Tiptap of our own next to an app pin, such as 3.34.0 next to 3.29.2,
// gave the app two copies and editors that did not fit its components.
it.each(["realtime", "content"])("@vite-hub/%s takes Tiptap and Yjs from the app", async (directory) => {
  const { dependencies = {}, peerDependencies = {}, peerDependenciesMeta = {} } = await manifest(directory)
  // Realtime bundles the collaboration extension and y-tiptap into its own files, so they stay dependencies.
  const bundled = new Set(["@tiptap/extension-collaboration", "@tiptap/y-tiptap"])
  const shared = (name: string) => (name.startsWith("@tiptap/") || name === "yjs") && !(directory === "realtime" && bundled.has(name))
  expect(Object.keys(dependencies).filter(shared)).toEqual([])
  expect(Object.keys(peerDependencies).filter(shared)).toContain("@tiptap/core")
  expect(Object.keys(peerDependenciesMeta).filter(name => shared(name) && peerDependenciesMeta[name]?.optional)).toEqual([])
})
