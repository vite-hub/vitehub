import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { createWorkspace } from "@vite-hub/workspace"
import { expect, it, vi } from "vitest"

import { createDocsManifest } from "../src/manifest.ts"

import type { WorkspaceDefinition } from "@vite-hub/workspace"
import type { DocsManifest } from "../src/types.ts"

const fixtures = resolve(import.meta.dirname, "fixtures/content")
const { files, state } = vi.hoisted(() => ({ files: new Map<string, string>(), state: {} as { manifest?: DocsManifest } }))
// The docs server modules: the manifest and files that the site's Content reads.
vi.mock("#docs/manifest", () => ({ get default() { return state.manifest } }))
vi.mock("#docs/files", () => ({ default: { read: async (store: string, file: string) => files.get(`${store}/${file}`) ?? await readFile(resolve(fixtures, file), "utf8").catch(() => null) } }))

const { docsAssistant } = await import("../src/assistant.ts")

// The merged settings that discovery and the runtime use.
function workspaceSources(agent: object): WorkspaceDefinition["sources"] {
  return Reflect.get(agent, "__vitehubWorkspaceAgentOptions").workspace.sources
}

function pagesWorkspace() {
  return createWorkspace({ name: "docs-assistant-pages", store: { driver: "memory" }, sources: workspaceSources(docsAssistant) })
}

it("lists the pages of the docs Content at their URL paths, and a page added to Content without a rebuild", async () => {
  const manifest = await createDocsManifest({ dir: fixtures, base: "/docs" })
  state.manifest = manifest
  const workspace = pagesWorkspace()

  const listed = (await workspace.glob("pages/**/*.md")).map(entry => entry.path)
  expect(listed).toEqual(expect.arrayContaining(["pages/index.md", "pages/about.md", "pages/docs/kv/index.md", "pages/docs/kv/ttl.md"]))
  expect(await workspace.readFile("pages/docs/kv/ttl.md")).toBe(await readFile(resolve(fixtures, "docs/kv/ttl.md"), "utf8"))

  // A page from another Source and mount, as `docs.sources` adds it: the Workspace path follows the URL, not the file.
  const ttl = manifest.sections.flatMap(section => section.pages).find(page => page.path === "/docs/kv/ttl")!
  manifest.pages.push({ ...ttl, path: "/docs/zoom/added", file: "guide/added.md", source: "docs-1" })
  files.set("docs-1/guide/added.md", "# Added\n\nA page that the server read after the Workspace was created.\n")

  // A provider Driver materializes the Sources before each turn, as here.
  await workspace.materializeSources?.()
  expect((await workspace.glob("pages/**/*.md")).map(entry => entry.path)).toContain("pages/docs/zoom/added.md")
  expect(await workspace.readFile("pages/docs/zoom/added.md")).toContain("A page that the server read")
})
