import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { glob as tinyglobby } from "tinyglobby"
import { afterEach, describe, expect, it, vi } from "vitest"

import { glob } from "../../src/glob.ts"

vi.mock("tinyglobby", () => ({
  glob: vi.fn(async () => ["docs/README.md"]),
}))

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-source-glob-cache-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("@vite-hub/source glob source cache", () => {
  it("reuses a prepared glob listing for item reads and metadata", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")

    const docs = glob({ include: "**/*.md" })
    const ctx = { rootDir: root }

    await docs.prepare?.(ctx)
    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/README.md"])
    await expect(docs.getItem("docs/README.md", ctx)).resolves.toMatchObject({ key: "docs/README.md" })
    await expect(docs.getMeta?.("docs/README.md", ctx)).resolves.toMatchObject({ digest: expect.any(String) })

    expect(tinyglobby).toHaveBeenCalledTimes(1)
  })

  it("can refresh glob keys on each read", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")
    vi.mocked(tinyglobby)
      .mockResolvedValueOnce(["docs/README.md"])
      .mockResolvedValueOnce(["docs/README.md", "docs/guide.md"])

    const docs = glob({ include: "**/*.md", keyCache: false })
    const ctx = { rootDir: root }

    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/README.md"])
    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/guide.md", "docs/README.md"])
    expect(tinyglobby).toHaveBeenCalledTimes(2)
  })

  it("evicts rejected glob listings from the key cache", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    vi.mocked(tinyglobby)
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce(["docs/README.md"])

    const docs = glob({ include: "**/*.md" })
    const ctx = { rootDir: root }

    await expect(docs.getKeys(ctx)).rejects.toThrow("transient failure")
    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/README.md"])
    expect(tinyglobby).toHaveBeenCalledTimes(2)
  })

  it("shares one in-flight glob listing across concurrent key reads", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    vi.mocked(tinyglobby).mockResolvedValueOnce(["docs/README.md"])

    const docs = glob({ include: "**/*.md" })
    const ctx = { rootDir: root }

    await expect(Promise.all([docs.getKeys(ctx), docs.getKeys(ctx)])).resolves.toEqual([
      ["docs/README.md"],
      ["docs/README.md"],
    ])
    expect(tinyglobby).toHaveBeenCalledTimes(1)
  })

  it("reuses live glob listings for item reads and refreshes missing keys", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n")
    vi.mocked(tinyglobby)
      .mockResolvedValueOnce(["docs/README.md"])
      .mockResolvedValueOnce(["docs/README.md", "docs/guide.md"])

    const docs = glob({ include: "**/*.md", keyCache: false })
    const ctx = { rootDir: root }

    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/README.md"])
    await expect(docs.getItem("docs/README.md", ctx)).resolves.toMatchObject({ key: "docs/README.md" })
    await expect(docs.getMeta?.("docs/README.md", ctx)).resolves.toMatchObject({ digest: expect.any(String) })
    expect(tinyglobby).toHaveBeenCalledTimes(1)

    await expect(docs.getItem("docs/guide.md", ctx)).resolves.toMatchObject({ key: "docs/guide.md" })
    expect(tinyglobby).toHaveBeenCalledTimes(2)
  })
})
