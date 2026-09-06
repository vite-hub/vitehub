import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { glob } from "../../src/glob.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-source-glob-symlinks-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("@vite-hub/source glob symbolic links", () => {
  it.each([
    ["the default options", {}],
    ["followSymlinks: false", { followSymlinks: false }],
    ["keyCache: false", { keyCache: false }],
  ])("rejects a file replaced by a symbolic link with %s", async (_name, options) => {
    const root = await createRoot()
    const outside = await createRoot()
    await writeFile(join(root, "doc.md"), "public")
    await writeFile(join(outside, "secret.md"), "secret")

    const docs = glob({ include: "**/*.md", ...options })
    const ctx = { rootDir: root }
    await expect(docs.getKeys(ctx)).resolves.toEqual(["doc.md"])

    await rm(join(root, "doc.md"))
    await symlink(join(outside, "secret.md"), join(root, "doc.md"))

    await expect(docs.getItem("doc.md", ctx)).rejects.toThrow("glob could not find")
    await expect(docs.getMeta?.("doc.md", ctx)).rejects.toThrow("glob could not find")
  })

  it("rejects a file whose parent directory becomes a symbolic link", async () => {
    const root = await createRoot()
    const outside = await createRoot()
    await mkdir(join(root, "docs"))
    await writeFile(join(root, "docs", "guide.md"), "public")
    await writeFile(join(outside, "guide.md"), "secret")

    const docs = glob({ include: "**/*.md" })
    const ctx = { rootDir: root }
    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/guide.md"])

    await rm(join(root, "docs"), { recursive: true })
    await symlink(outside, join(root, "docs"))

    await expect(docs.getItem("docs/guide.md", ctx)).rejects.toThrow("glob could not find")
    await expect(docs.getMeta?.("docs/guide.md", ctx)).rejects.toThrow("glob could not find")
  })

  it("rejects a file replaced by a dangling symbolic link", async () => {
    const root = await createRoot()
    await writeFile(join(root, "doc.md"), "public")

    const docs = glob({ include: "**/*.md" })
    const ctx = { rootDir: root }
    await expect(docs.getKeys(ctx)).resolves.toEqual(["doc.md"])

    await rm(join(root, "doc.md"))
    await symlink(join(root, "missing.md"), join(root, "doc.md"))

    await expect(docs.getItem("doc.md", ctx)).rejects.toThrow("glob could not find")
    await expect(docs.getMeta?.("doc.md", ctx)).rejects.toThrow("glob could not find")
  })

  it("rejects a symbolic link whose target stays inside the source root", async () => {
    const root = await createRoot()
    await writeFile(join(root, "doc.md"), "public")
    await writeFile(join(root, "target.md"), "target")

    const docs = glob({ include: "doc.md" })
    const ctx = { rootDir: root }
    await expect(docs.getKeys(ctx)).resolves.toEqual(["doc.md"])

    await rm(join(root, "doc.md"))
    await symlink(join(root, "target.md"), join(root, "doc.md"))

    await expect(docs.getItem("doc.md", ctx)).rejects.toThrow("glob could not find")
    await expect(docs.getMeta?.("doc.md", ctx)).rejects.toThrow("glob could not find")
  })

  it("rejects include patterns that select a parent path", async () => {
    const root = await createRoot()
    const outside = await createRoot()
    await writeFile(join(outside, "secret.md"), "secret")

    const include = relative(root, join(outside, "secret.md")).replaceAll("\\", "/")

    await expect(glob({ include }).getKeys({ rootDir: root }))
      .rejects.toThrow("Source path escapes the source root")
  })

  it("follows only root-confined symbolic links when followSymlinks is true", async () => {
    const root = await createRoot()
    const outside = await createRoot()
    await mkdir(join(root, "workspace"))
    await mkdir(join(root, "shared"))
    await writeFile(join(root, "shared", "inside.md"), "inside")
    await writeFile(join(outside, "outside.md"), "outside")
    await writeFile(join(root, "workspace", "replace-inside.md"), "public")
    await writeFile(join(root, "workspace", "replace-outside.md"), "public")
    await symlink(join(root, "shared", "inside.md"), join(root, "workspace", "inside.md"))
    await symlink(join(outside, "outside.md"), join(root, "workspace", "outside.md"))

    const docs = glob({ cwd: "workspace", followSymlinks: true, include: "**/*.md" })
    const ctx = { rootDir: root }

    await expect(docs.getKeys(ctx)).resolves.toEqual([
      "inside.md",
      "replace-inside.md",
      "replace-outside.md",
    ])

    await rm(join(root, "workspace", "replace-inside.md"))
    await rm(join(root, "workspace", "replace-outside.md"))
    await symlink(join(root, "shared", "inside.md"), join(root, "workspace", "replace-inside.md"))
    await symlink(join(outside, "outside.md"), join(root, "workspace", "replace-outside.md"))

    await expect(docs.getItem("inside.md", ctx)).resolves.toMatchObject({
      content: new TextEncoder().encode("inside"),
    })
    await expect(docs.getItem("replace-inside.md", ctx)).resolves.toMatchObject({
      content: new TextEncoder().encode("inside"),
    })
    await expect(docs.getMeta?.("replace-inside.md", ctx)).resolves.toMatchObject({
      digest: expect.any(String),
    })
    await expect(docs.getItem("replace-outside.md", ctx)).rejects.toThrow("glob could not find")
    await expect(docs.getMeta?.("replace-outside.md", ctx)).rejects.toThrow("glob could not find")
  })

  it("separates cached keys for different source roots with the same cwd", async () => {
    const root = await createRoot()
    const workspace = join(root, "workspace")
    await mkdir(workspace)
    await writeFile(join(root, "shared.md"), "shared")
    await symlink(join(root, "shared.md"), join(workspace, "linked.md"))

    const docs = glob({ cwd: workspace, followSymlinks: true, include: "**/*.md" })

    await expect(docs.getKeys({ rootDir: root })).resolves.toEqual(["linked.md"])
    await expect(docs.getKeys({ rootDir: workspace })).resolves.toEqual([])
  })
})
