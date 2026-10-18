import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { glob } from "../../src/glob.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it("uses backslashes as separators for both include and ignore", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-glob-patterns-"))
  roots.push(root)
  await mkdir(join(root, "docs"))
  await writeFile(join(root, "docs", "keep.md"), "keep")
  await writeFile(join(root, "docs", "skip.md"), "skip")
  await expect(glob({ include: "docs\\*.md", ignore: "docs\\skip.*" }).getKeys({ rootDir: root }))
    .resolves.toEqual(["docs/keep.md"])
})

it.each([
  ["file[1].md", "file[[]1].md", "file1.md"],
  ...(process.platform === "win32" ? [] : [
    ["file*.md", "file[*].md", "file-other.md"],
    ["file?.md", "file[?].md", "file1.md"],
  ]),
])("matches literal %s without broadening include or ignore", async (literal, pattern, other) => {
  const root = await mkdtemp(join(tmpdir(), "source-glob-patterns-"))
  roots.push(root)
  await mkdir(join(root, "docs"))
  await writeFile(join(root, "docs", literal!), "literal")
  await writeFile(join(root, "docs", other!), "other")
  for (const separator of ["/", "\\"]) {
    await expect(glob({ include: `docs${separator}${pattern}` }).getKeys({ rootDir: root }))
      .resolves.toEqual([`docs/${literal}`])
    await expect(glob({ include: `docs${separator}*.md`, ignore: `docs${separator}${pattern}` }).getKeys({ rootDir: root }))
      .resolves.toEqual([`docs/${other}`])
  }
})
