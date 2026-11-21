import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"
import { readBuiltWorkspaceImports } from "../../internal/test-utils/built-workspace-imports.js"

const dist = new URL("../dist/", import.meta.url)

/** Bare specifiers that a built entry loads at startup, following its own static imports. */
async function startupImports(entry: string): Promise<Set<string>> {
  const bare = new Set<string>()
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const code = await readFile(new URL(file, dist), "utf8")
    for (const match of code.matchAll(/^(?:import|export)\b[^"']*?from\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/gm)) {
      const specifier = match[1] ?? match[2] ?? ""
      if (specifier.startsWith(".")) pending.push(new URL(specifier, new URL(file, dist)).href.slice(dist.href.length))
      else bare.add(specifier)
    }
  }
  return bare
}

describe("@vite-hub/content package contract", () => {
  it("loads documented exports from built package targets", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/content", [
      ".",
      "./client",
      "./collections",
      "./database",
    ])
  })

  it("leaves the Markdown preset external for consumer deduplication", async () => {
    expect(await startupImports("index.js")).toContain("comark-ui/html")
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    expect(manifest.dependencies).not.toHaveProperty("comark-ui")
    expect(manifest.peerDependencies["comark-ui"]).toBeTruthy()
  })

  it("loads Workspace and Database only from the collections entry", async () => {
    const workspaceOrDatabase = (imports: Set<string>) => [...imports].filter(specifier => /^@vite-hub\/(?:workspace|database)(?:\/|$)/.test(specifier))

    expect(workspaceOrDatabase(await startupImports("index.js"))).toEqual([])
    expect(workspaceOrDatabase(await startupImports("vite.js"))).toEqual([])
    expect(workspaceOrDatabase(await startupImports("collections.js"))).toContain("@vite-hub/workspace/files")
  })

  it.each(["collections.js", "realtime.js"])("keeps built %s off the Workspace Agent tool graph", async entry => {
    const graph = await readBuiltWorkspaceImports(new URL(entry, dist))
    // Collections read `derivedFrom` of translations. `@vite-hub/workspace/lineage` only hashes and parses bytes.
    expect([...graph.imports].sort()).toEqual(entry === "collections.js" ? ["@vite-hub/workspace/files", "@vite-hub/workspace/lineage"] : ["@vite-hub/workspace/files"])
    expect(graph.code).not.toContain("maxShellCalls")
    expect(graph.code).not.toContain("@vite-hub/shell/workspace")
  })

  it("leaves the Tiptap editor packages optional, so only apps that edit install them", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    const tiptap = Object.keys(manifest.peerDependencies).filter(name => name.startsWith("@tiptap/"))
    expect(tiptap.length).toBeGreaterThan(0)
    for (const name of tiptap) expect(manifest.peerDependenciesMeta[name], name).toEqual({ optional: true })
  })

  it.each(["editor", "realtime"])("names the missing Tiptap packages when ./%s loads without them", async (entry) => {
    // A Node app that has Content and Comark UI, but no Tiptap packages.
    const app = await mkdtemp(join(tmpdir(), "content-editor-peers-"))
    try {
      const content = join(app, "node_modules/@vite-hub/content")
      await mkdir(content, { recursive: true })
      await cp(new URL("../package.json", import.meta.url), join(content, "package.json"))
      await cp(new URL("../dist/", import.meta.url), join(content, "dist"), { recursive: true })
      // Content's own dependencies, without Comark UI and the editor packages.
      const installed = fileURLToPath(new URL("../node_modules/", import.meta.url))
      const link = async (name: string) => symlink(await realpath(join(installed, name)), join(app, "node_modules", name))
      for (const entry of await readdir(installed)) {
        if (entry === ".bin" || entry === "comark-ui" || entry === "@tiptap" || entry.startsWith("prosemirror-")) continue
        if (!entry.startsWith("@")) {
          await link(entry)
          continue
        }
        await mkdir(join(app, "node_modules", entry), { recursive: true })
        for (const name of await readdir(join(installed, entry))) {
          if (`${entry}/${name}` !== "@vite-hub/content") await link(`${entry}/${name}`)
        }
      }
      const comarkUi = join(app, "node_modules/comark-ui")
      await mkdir(comarkUi, { recursive: true })
      await writeFile(join(comarkUi, "package.json"), JSON.stringify({ name: "comark-ui", type: "module", exports: { "./editor": "./editor.js", "./html": "./html.js" } }))
      await writeFile(join(comarkUi, "editor.js"), "import \"@tiptap/core\"\n")
      await writeFile(join(comarkUi, "html.js"), "export default () => ({ plugins: [] })\n")

      const script = `try { await import("@vite-hub/content/${entry}"); console.log("loaded") } catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message, fix: error.fix, cause: error.cause?.code })) }`
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: app })
      expect(JSON.parse(stdout)).toEqual({
        code: "CONTENT_EDITOR_PACKAGES_MISSING",
        message: expect.stringContaining("@tiptap/core"),
        fix: expect.stringContaining("@tiptap/starter-kit"),
        cause: "ERR_MODULE_NOT_FOUND",
      })
    }
    finally {
      await rm(app, { recursive: true, force: true })
    }
  })
})
