import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { noWorkspaceVersions } from "../src/runnable/build.ts"
import { buildPlaygroundTemplates, snapshotSources } from "../src/runnable/playground.ts"
import { dependencyKey } from "../src/runnable/steps.ts"

let dir: string
beforeEach(async () => { dir = await mkdtemp(resolve(tmpdir(), "runnable-playground-")) })
afterEach(() => rm(dir, { recursive: true, force: true }))

async function write(path: string, contents: string) {
  await mkdir(dirname(resolve(dir, path)), { recursive: true })
  await writeFile(resolve(dir, path), contents)
}

const lessons = [{ slug: "first-kv", page: "/docs/kv", fixture: "kv" }]
const examples = [
  { id: "kv", label: "KV", description: "Store a value.", fixture: "kv-example", open: "server/api/kv.get.ts", preview: "/api/kv" },
  { id: "blob", label: "Blob", description: "Store a file.", fixture: "blob", open: "server/api/blob.get.ts", preview: "/api/blob" },
]

async function fixtures() {
  await write("fixtures/kv/package.json", JSON.stringify({ name: "kv", dependencies: { "vite-hub": "^1.0.0", "@vite-hub/kv": "^1.0.0" } }))
  // Same dependencies as the lesson in another order, and other scripts: it shares the snapshot of the lesson.
  await write("fixtures/kv-example/package.json", JSON.stringify({ name: "kv-example", scripts: { dev: "vite" }, dependencies: { "@vite-hub/kv": "^1.0.0", "vite-hub": "^1.0.0" } }))
  await write("fixtures/kv-example/server/api/kv.get.ts", "export default () => 1\n")
  await write("fixtures/blob/package.json", JSON.stringify({ name: "blob", dependencies: { "vite-hub": "^1.0.0", "@vite-hub/blob": "^1.0.0" } }))
  await write("fixtures/blob/server/api/blob.get.ts", "export default () => 2\n")
}

describe("playground examples", () => {
  it("reads each example from its fixture and shares the snapshot of a lesson with the same dependencies", async () => {
    await fixtures()
    const templates = await buildPlaygroundTemplates({ fixturesDir: resolve(dir, "fixtures"), versions: noWorkspaceVersions, tutorials: lessons, examples })
    expect(templates.map(template => [template.id, template.snapshotOf])).toEqual([["kv", "first-kv"], ["blob", "playground-blob"]])
    expect(templates[0]).toMatchObject({ label: "KV", description: "Store a value.", open: "server/api/kv.get.ts", preview: "/api/kv" })
    expect(templates[0]!.files["server/api/kv.get.ts"]).toBe("export default () => 1\n")

    // Each distinct install needs its own snapshot.
    expect(snapshotSources(lessons, examples, templates)).toEqual([
      ...lessons,
      { slug: "playground-blob", page: "/playground", fixture: "blob" },
    ])
  })

  it("rejects a template without an example", () => {
    expect(() => snapshotSources(lessons, examples, [{ id: "missing", snapshotOf: "playground-missing" }])).toThrow("No playground example with the id missing.")
  })

  it("compares installs by dependencies only", () => {
    const manifest = (dependencies: Record<string, string>, extra = {}) => JSON.stringify({ name: "app", dependencies, ...extra })
    expect(dependencyKey(manifest({ b: "1", a: "2" }))).toBe(dependencyKey(manifest({ a: "2", b: "1" }, { scripts: { dev: "vite" } })))
    expect(dependencyKey(manifest({ a: "2" }))).not.toBe(dependencyKey(manifest({ a: "3" })))
    expect(dependencyKey("{")).toBe("invalid")
  })
})
