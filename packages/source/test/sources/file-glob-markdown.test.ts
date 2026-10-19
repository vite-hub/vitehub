import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { clearSources, createSource, defineSources, registerSources, useSource } from "../../src/index.ts"
import { file } from "../../src/file.ts"
import type { FileSourceOptions } from "../../src/file.ts"
import { glob } from "../../src/glob.ts"
import { markdown } from "../../src/markdown.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-source-root-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  clearSources()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("@vite-hub/source local file sources", () => {
  it.each(["../outside.md", "/outside.md", "./README.md"])('rejects unsafe workspace paths %j', (workspacePath) => {
    expect(() => file({ content: "# Docs\n", workspacePath })).toThrow("Source path escapes the source root")
  })
  it.each(["C:/outside/file", "C:\\outside\\file", "C:outside", "a\0b"])("rejects non-portable file path %j", (path) => {
    expect(() => file(path)).toThrow("Source path escapes the source root")
  })

  it.each(["C:/outside", "C:\\outside", "C:outside", "a\0b"])("rejects non-portable glob cwd %j", async (cwd) => {
    const root = await createRoot()

    await expect(glob({ cwd, include: "**/*.md" }).getKeys({ rootDir: root }))
      .rejects.toThrow("Source path escapes the source root")
  })

  it("preserves relative file paths as default workspace paths", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")

    const readme = file("docs/README.md")

    await expect(readme.getKeys({ rootDir: root })).resolves.toEqual(["docs/README.md"])
    await expect(readme.getItem("docs/README.md", { rootDir: root })).resolves.toMatchObject({
      path: "docs/README.md",
      mediaType: "text/markdown",
    })
  })

  it("ignores inherited file options", async () => {
    const root = await createRoot()
    await writeFile(join(root, "safe.md"), "# Safe\n")
    await writeFile(join(root, "outside.md"), "# Outside\n")

    const pathOptions = Object.assign(
      Object.create({ content: "inherited", mediaType: "text/plain", workspacePath: "inherited.md" }),
      { path: "safe.md" },
    ) as FileSourceOptions
    const pathSource = file(pathOptions)

    await expect(pathSource.getKeys({ rootDir: root })).resolves.toEqual(["safe.md"])
    await expect(pathSource.getItem("safe.md", { rootDir: root })).resolves.toMatchObject({
      content: new TextEncoder().encode("# Safe\n"),
      key: "safe.md",
      mediaType: "text/markdown",
    })

    const inlineOptions = Object.assign(
      Object.create({ path: "outside.md" }),
      { content: "# Inline\n", workspacePath: "inline.md" },
    ) as FileSourceOptions
    const inlineSource = file(inlineOptions)
    await expect(inlineSource.getKeys({ rootDir: root })).resolves.toEqual(["inline.md"])
    await expect(inlineSource.getItem("inline.md", { rootDir: root })).resolves.toMatchObject({
      content: "# Inline\n",
    })

    const pathlessOptions = Object.assign(
      Object.create({ path: "outside.md" }),
      { workspacePath: "pathless.md" },
    ) as FileSourceOptions
    const pathlessSource = file(pathlessOptions)
    await expect(pathlessSource.getItem("pathless.md", { rootDir: root }))
      .rejects.toThrow("file requires path when content is not provided")
  })

  it("accepts Windows separators in portable glob patterns", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")

    await expect(glob({ include: "docs\\*.md" }).getKeys({ rootDir: root }))
      .resolves.toEqual(["docs/README.md"])
  })

  it("loads file, markdown, and glob providers", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n")
    await writeFile(join(root, "node_modules", "pkg", "skip.md"), "# Skip\n")

    registerSources(defineSources({
      docs: glob({ cwd: ".", include: "**/*.md" }),
      readme: markdown({ path: "docs/README.md", workspacePath: "README.md" }),
    }))

    await expect(useSource("docs", { rootDir: root }).keys()).resolves.toEqual([
      "docs/guide.md",
      "docs/README.md",
    ])
    await expect(useSource("readme", { rootDir: root }).get("README.md")).resolves.toMatchObject({
      mediaType: "text/markdown",
    })
    await expect(useSource("readme", { rootDir: root }).read("missing.md" as any))
      .rejects.toThrow("file could not find")
    await expect(useSource("docs", { rootDir: root }).read("../package.json" as any))
      .rejects.toThrow("glob could not find")
  })

  it("keeps a prepared glob listing local to each reader", async () => {
    const root = await createRoot()
    await writeFile(join(root, "first.md"), "# First\n")
    const docs = glob({ include: "**/*.md" })
    const first = createSource(docs, { rootDir: root })
    await expect(first.keys()).resolves.toEqual(["first.md"])

    await writeFile(join(root, "second.md"), "# Second\n")
    const second = createSource(docs, { rootDir: root })
    await expect(second.keys()).resolves.toEqual(["first.md", "second.md"])

    await expect(first.keys()).resolves.toEqual(["first.md"])
    await expect(first.items()).resolves.toMatchObject([{ key: "first.md" }])
    await expect(first.get("second.md")).rejects.toThrow("glob could not find")
    await expect(first.meta("second.md")).rejects.toThrow("glob could not find")
    await expect(second.read("second.md")).resolves.toBe("# Second\n")
  })

  it("resolves relative glob cwd from the source root", async () => {
    const root = await createRoot()
    const sourceRoot = join(root, "server", "agents", "docs", "workspace")
    await mkdir(join(root, "docs"), { recursive: true })
    await mkdir(join(sourceRoot, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "project.md"), "# Project\n")
    await writeFile(join(sourceRoot, "docs", "workspace.md"), "# Workspace\n")

    await expect(glob({ cwd: ".", include: "**/*.md" }).getKeys({
      rootDir: root,
      sourceRootDir: sourceRoot,
    })).resolves.toEqual([
      "docs/workspace.md",
    ])
  })

  it("preserves sourceRootDir in useSource contexts", async () => {
    const root = await createRoot()
    const sourceRoot = join(root, "server", "agents", "docs", "workspace")
    await mkdir(join(root, "docs"), { recursive: true })
    await mkdir(join(sourceRoot, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "project.md"), "# Project\n")
    await writeFile(join(sourceRoot, "docs", "workspace.md"), "# Workspace\n")

    registerSources(defineSources({
      docs: glob({ cwd: ".", include: "**/*.md" }),
    }))

    await expect(useSource("docs", { rootDir: root, sourceRootDir: sourceRoot }).keys()).resolves.toEqual([
      "docs/workspace.md",
    ])
  })

  it("uses ignore, dot, prefix, and cwd boundary options for glob providers", async () => {
    const root = await createRoot()
    const outside = await createRoot()
    await mkdir(join(root, "workspace", "drafts"), { recursive: true })
    await writeFile(join(root, "workspace", "README.md"), "# Docs\n")
    await writeFile(join(root, "workspace", ".secret.md"), "# Secret\n")
    await writeFile(join(root, "workspace", "drafts", "skip.md"), "# Skip\n")
    await writeFile(join(outside, "outside.md"), "# Outside\n")
    await symlink(join(outside, "outside.md"), join(root, "workspace", "linked.md"))
    await symlink(outside, join(root, "workspace", "outside"))

    const docs = glob({
      cwd: "workspace",
      dot: true,
      ignore: "drafts/**",
      include: "**/*.md",
      prefix: "content",
    })

    await expect(docs.getKeys({ rootDir: root })).resolves.toEqual([
      ".secret.md",
      "README.md",
    ])
    await expect(docs.getItem("README.md", { rootDir: root })).resolves.toMatchObject({
      path: "content/README.md",
    })
    await expect(glob({ cwd: "workspace", include: "**/*.md" }).getKeys({ rootDir: root })).resolves.toEqual([
      "drafts/skip.md",
      "README.md",
    ])
    await expect(glob({ cwd: resolve(root, "workspace"), include: "**/*.md" }).getKeys({ rootDir: root })).resolves.toEqual([
      "drafts/skip.md",
      "README.md",
    ])
    await expect(glob({ cwd: outside, include: "**/*.md" }).getKeys({ rootDir: root }))
      .rejects.toThrow("glob cwd escapes the source root")
    await expect(glob({ cwd: "workspace/outside", include: "**/*.md" }).getKeys({ rootDir: root }))
      .rejects.toThrow("glob cwd escapes the source root")
  })

  it("rejects file provider symlinks that escape the source root", async () => {
    const root = await createRoot()
    const outside = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(outside, "secret.md"), "# Secret\n")
    await symlink(join(outside, "secret.md"), join(root, "docs", "linked.md"))

    const readme = markdown({ path: "docs/linked.md", workspacePath: "linked.md" })

    await expect(readme.getItem("linked.md", { rootDir: root })).rejects.toThrow("Source path escapes the source root")
    await expect(readme.getMeta?.("linked.md", { rootDir: root })).rejects.toThrow("Source path escapes the source root")
  })
})
