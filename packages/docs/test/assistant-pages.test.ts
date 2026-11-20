import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createWorkspace } from "@vite-hub/workspace"
import { expect, it, vi } from "vitest"

import { docsFilesModule } from "../src/files.ts"
import { createDocsManifest } from "../src/manifest.ts"

import type { WorkspaceDefinition } from "@vite-hub/workspace"
import type { DocsPackedFiles } from "../src/files.ts"
import type { DocsManifest } from "../src/types.ts"

const fixtures = resolve(import.meta.dirname, "fixtures/content")
const { state } = vi.hoisted(() => ({ state: {} as { manifest?: DocsManifest, files?: DocsPackedFiles } }))
// The docs server modules: the manifest and files that the site's Content reads.
vi.mock("#docs/manifest", () => ({ get default() { return state.manifest } }))
vi.mock("#docs/files", () => ({ get default() { return state.files } }))

const { docsAssistant } = await import("../src/assistant.ts")

// The merged settings that discovery and the runtime use.
function workspaceSources(agent: object): WorkspaceDefinition["sources"] {
  return Reflect.get(agent, "__vitehubWorkspaceAgentOptions").workspace.sources
}

function pagesWorkspace() {
  return createWorkspace({ name: "docs-assistant-pages", store: { driver: "memory" }, sources: workspaceSources(docsAssistant) })
}

async function packedFiles(...stores: Parameters<typeof docsFilesModule>[0]) {
  const source = docsFilesModule(stores)
  const { default: files } = await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`) as { default: DocsPackedFiles }
  return files
}

it("indexes a manifest snapshot once and sees mounted pages from a development reload", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "docs-assistant-mount-"))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, "guide"))
  await writeFile(join(dir, "guide/added.md"), "# Added\n\nA page that the server read after the Workspace was created.\n")
  const manifest = await createDocsManifest({ dir: fixtures, base: "/docs" })
  const pages = vi.fn(() => manifest.pages)
  state.manifest = { ...manifest, get pages() { return pages() } }
  state.files = await packedFiles({ name: "docs", dir: fixtures }, { name: "docs-1", dir })
  const workspace = pagesWorkspace()

  const listed = (await workspace.glob("pages/**/*.md")).map(entry => entry.path)
  expect(listed).toEqual(expect.arrayContaining(["pages/index.md", "pages/about.md", "pages/docs/kv/index.md", "pages/docs/kv/ttl.md"]))
  expect(await workspace.readFile("pages/docs/kv/ttl.md")).toBe(await readFile(resolve(fixtures, "docs/kv/ttl.md"), "utf8"))
  expect(pages).toHaveBeenCalledTimes(1)

  // A page from another Source and mount, as `docs.sources` adds it: the Workspace path follows the URL, not the file.
  const ttl = manifest.sections.flatMap(section => section.pages).find(page => page.path === "/docs/kv/ttl")!
  state.manifest = { ...manifest, pages: [...manifest.pages, { ...ttl, path: "/docs/zoom/added", file: "guide/added.md", source: "docs-1" }] }

  // A provider Driver materializes the Sources before each turn, as here.
  await workspace.materializeSources?.()
  expect((await workspace.glob("pages/**/*.md")).map(entry => entry.path)).toContain("pages/docs/zoom/added.md")
  expect(await workspace.readFile("pages/docs/zoom/added.md")).toContain("A page that the server read")
})

it("skips manifest pages absent from the packed file store", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "docs-assistant-hidden-"))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, "docs/guide"), { recursive: true })
  await writeFile(join(dir, "docs/guide/.notes.md"), "---\ntitle: Notes\n---\n# Notes\n")
  await writeFile(join(dir, "docs/guide/setup.md"), "---\ntitle: Setup\n---\n# Setup\n")
  state.manifest = await createDocsManifest({ dir, base: "/docs" })
  state.files = await packedFiles({ name: "docs", dir })
  vi.resetModules()
  const { docsAssistant } = await import("../src/assistant.ts")
  const workspace = createWorkspace({ name: "docs-assistant-hidden", store: { driver: "memory" }, sources: workspaceSources(docsAssistant) })

  expect(JSON.stringify(state.manifest)).toContain("docs/guide/.notes.md")
  expect((await workspace.glob("pages/**/*.md")).map(entry => entry.path)).toEqual(["pages/docs/guide/setup.md"])
  expect(await workspace.readFile("pages/docs/guide/setup.md")).toContain("# Setup")
})
