import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  createRuntimeRegistryContents,
  listSourceFiles,
  mergeDefinitions,
  normalizePathDefinitionName,
  registerDefinition,
  sanitizeDefinitionFilename,
  writeFileIfChanged,
} from "../src/definition-discovery.ts"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe("listSourceFiles", () => {
  it("returns source files sorted, skipping .d.ts and ignored dirs", async () => {
    const root = await createTempDir("vitehub-internal-list-")
    await mkdir(join(root, "node_modules"), { recursive: true })
    await mkdir(join(root, "nested"), { recursive: true })
    await writeFile(join(root, "b.ts"), "", "utf8")
    await writeFile(join(root, "a.ts"), "", "utf8")
    await writeFile(join(root, "types.d.ts"), "", "utf8")
    await writeFile(join(root, "nested", "c.mjs"), "", "utf8")
    await writeFile(join(root, "node_modules", "ignored.ts"), "", "utf8")

    const files = listSourceFiles(root).map(file => file.replace(`${root}/`, ""))
    expect(files).toEqual(["a.ts", "b.ts", "nested/c.mjs"])
  })

  it("returns empty when root does not exist", () => {
    expect(listSourceFiles(join(tmpdir(), "vitehub-internal-missing-dir"))).toEqual([])
  })
})

describe("normalizePathDefinitionName", () => {
  it("strips extension and /index suffix", () => {
    expect(normalizePathDefinitionName("/root", "/root/billing/index.ts")).toBe("billing")
    expect(normalizePathDefinitionName("/root", "/root/emails/welcome.ts")).toBe("emails/welcome")
  })

  it("handles .mjs and .cts extensions", () => {
    expect(normalizePathDefinitionName("/root", "/root/a.mjs")).toBe("a")
    expect(normalizePathDefinitionName("/root", "/root/a.cts")).toBe("a")
  })
})

describe("registerDefinition", () => {
  it("throws on duplicate name with both handler paths", () => {
    const map = new Map<string, { handler: string, name: string }>()
    registerDefinition(map, { handler: "/a/welcome.ts", name: "welcome" }, "queue")
    expect(() => registerDefinition(map, { handler: "/b/welcome.ts", name: "welcome" }, "queue"))
      .toThrow(/Duplicate queue name "welcome":[\s\S]*\/a\/welcome\.ts[\s\S]*\/b\/welcome\.ts/)
  })
})

describe("mergeDefinitions", () => {
  it("deduplicates same-handler definitions across sources", () => {
    const shared = { handler: "/a/welcome.ts", name: "welcome" }
    expect(mergeDefinitions("queue", [shared], [shared])).toEqual([shared])
  })

  it("throws on same name with different handlers", () => {
    expect(() => mergeDefinitions(
      "queue",
      [{ handler: "/a/welcome.ts", name: "welcome", source: "vite" }],
      [{ handler: "/b/welcome.ts", name: "welcome", source: "nitro" }],
    )).toThrow(/Duplicate queue name "welcome" from multiple discovery sources/)
  })

  it("skips undefined sources and sorts by name", () => {
    expect(mergeDefinitions(
      "queue",
      undefined,
      [{ handler: "/b.ts", name: "b" }],
      [{ handler: "/a.ts", name: "a" }],
    ).map(d => d.name)).toEqual(["a", "b"])
  })
})

describe("createRuntimeRegistryContents", () => {
  it("creates a sync import map with relative paths", () => {
    const registryFile = "/root/.vitehub/sandbox/registry.mjs"
    const contents = createRuntimeRegistryContents(registryFile, [{
      handler: "/root/server/sandboxes/release-notes.ts",
      name: "release-notes",
    }])
    expect(contents).toContain('"release-notes": async () => import("../../server/sandboxes/release-notes.ts")')
    expect(contents).toContain("export default registry")
  })
})

describe("writeFileIfChanged", () => {
  it("writes new files and creates parent dirs", async () => {
    const root = await createTempDir("vitehub-internal-write-")
    const target = join(root, "nested", "file.mjs")
    await writeFileIfChanged(target, "hello")
    expect(await readFile(target, "utf8")).toBe("hello")
  })

  it("skips writing when contents match", async () => {
    const root = await createTempDir("vitehub-internal-write-same-")
    const target = join(root, "file.mjs")
    await writeFile(target, "same", "utf8")
    const before = (await import("node:fs/promises")).stat(target).then(s => s.mtimeMs)
    const beforeMs = await before
    await new Promise(resolve => setTimeout(resolve, 10))
    await writeFileIfChanged(target, "same")
    const afterMs = await (await import("node:fs/promises")).stat(target).then(s => s.mtimeMs)
    expect(afterMs).toBe(beforeMs)
  })

  it("overwrites when contents differ", async () => {
    const root = await createTempDir("vitehub-internal-write-diff-")
    const target = join(root, "file.mjs")
    await writeFile(target, "old", "utf8")
    await writeFileIfChanged(target, "new")
    expect(await readFile(target, "utf8")).toBe("new")
  })
})

describe("sanitizeDefinitionFilename", () => {
  it("escapes slashes and colons distinctly", () => {
    expect(sanitizeDefinitionFilename("foo/bar")).toBe("foo_sbar")
    expect(sanitizeDefinitionFilename("ns:foo/bar")).toBe("ns_cfoo_sbar")
  })

  it("doubles literal underscores so they never collide with escapes", () => {
    expect(sanitizeDefinitionFilename("foo_bar")).toBe("foo__bar")
    expect(sanitizeDefinitionFilename("valid-name_01")).toBe("valid-name__01")
  })

  it("hex-encodes other unsafe chars", () => {
    expect(sanitizeDefinitionFilename("bad char!")).toBe("bad_x0020char_x0021")
  })

  it("is injective across collision-prone inputs", () => {
    const inputs = ["a/b", "a:b", "a_b", "a b", "a__b", "a_sb"]
    const outputs = new Set(inputs.map(sanitizeDefinitionFilename))
    expect(outputs.size).toBe(inputs.length)
  })
})
