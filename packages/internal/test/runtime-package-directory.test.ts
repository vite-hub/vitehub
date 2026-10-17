import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { copyVercelFunctionRuntimePackages } from "../src/build/vercel-runtime-packages.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const roots: string[] = []

afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(rename).mockReset().mockImplementation(actual.rename)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(existing = true) {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-runtime-package-directory-"))
  roots.push(rootDir)
  const outputRoot = join(rootDir, "output")
  const functionDir = join(outputRoot, "functions", "__server.func")
  const directory = join(functionDir, "node_modules")
  const source = join(rootDir, "node_modules", "runtime-package")
  await mkdir(source, { recursive: true })
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "runtime-package", version: "1.0.0", main: "index.js" }))
  await writeFile(join(source, "index.js"), "export default 'new'\n")
  await mkdir(functionDir, { recursive: true })
  if (existing) {
    await mkdir(join(directory, "runtime-package"), { recursive: true })
    await writeFile(join(directory, "runtime-package", "index.js"), "export default 'old'\n")
    await writeFile(join(directory, "unrelated.txt"), "preserved")
  }
  return { rootDir, outputRoot, functionDir, directory, packages: [{ name: "runtime-package" }] }
}

const adapters = [
  { name: "traced packages", copy: copyVercelFunctionRuntimePackages },
]

describe.each(adapters)("runtime package publication: $name", ({ copy }) => {
  it("publishes new packages while preserving unrelated output and removing staging", async () => {
    const project = await fixture()
    await copy(project)
    await expect(readFile(join(project.directory, "runtime-package", "index.js"), "utf8")).resolves.toContain("'new'")
    await expect(readFile(join(project.directory, "unrelated.txt"), "utf8")).resolves.toBe("preserved")
    await expect(readdir(project.functionDir)).resolves.toEqual(["node_modules"])
  })

  it.each(["backup", "replacement"])("restores existing output when cancelled after %s", async (phase) => {
    const project = await fixture()
    const controller = new AbortController()
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(rename).mockImplementation(async (source, target) => {
      await actual.rename(source, target)
      if (phase === "backup" ? source === project.directory : target === project.directory) controller.abort()
    })
    await expect(copy({ ...project, signal: controller.signal })).rejects.toHaveProperty("name", "AbortError")
    await expect(readFile(join(project.directory, "runtime-package", "index.js"), "utf8")).resolves.toContain("'old'")
    await expect(readdir(project.functionDir)).resolves.toEqual(["node_modules"])
  })

  it("removes a cancelled replacement when there was no previous output", async () => {
    const project = await fixture(false)
    const controller = new AbortController()
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(rename).mockImplementation(async (source, target) => {
      await actual.rename(source, target)
      if (target === project.directory) controller.abort()
    })
    await expect(copy({ ...project, signal: controller.signal })).rejects.toHaveProperty("name", "AbortError")
    await expect(readdir(project.functionDir)).resolves.toEqual([])
  })

  it("restores the previous output if publishing the staged copy fails", async () => {
    const project = await fixture()
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const failure = new Error("publication failed")
    vi.mocked(rename).mockImplementation(async (source, target) => {
      if (target === project.directory && basename(String(source)) === "node_modules") throw failure
      await actual.rename(source, target)
    })
    await expect(copy(project)).rejects.toBe(failure)
    await expect(readFile(join(project.directory, "runtime-package", "index.js"), "utf8")).resolves.toContain("'old'")
    await expect(readdir(project.functionDir)).resolves.toEqual(["node_modules"])
  })

  it("retains the previous output in staging if rollback fails", async () => {
    const project = await fixture()
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const failure = new Error("restoration failed")
    vi.mocked(rename).mockImplementation(async (source, target) => {
      if (target === project.directory) throw failure
      await actual.rename(source, target)
    })
    await expect(copy(project)).rejects.toBe(failure)
    const staging = (await readdir(project.functionDir)).filter(name => name.startsWith(".vitehub-runtime-packages-"))
    expect(staging).toHaveLength(1)
    await expect(readFile(join(project.functionDir, staging[0]!, "previous-node_modules", "runtime-package", "index.js"), "utf8")).resolves.toContain("'old'")
  })
})
