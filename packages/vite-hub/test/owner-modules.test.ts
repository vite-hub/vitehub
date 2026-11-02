import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, expect, it, vi } from "vitest"
import { resolveConfig } from "vite"

import { optionalOwnerEntriesPlugin } from "../src/internal/owner-modules.ts"
import { assertFeaturePackages } from "../src/internal/optional-owners.ts"

vi.mock("../src/internal/optional-owners.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/internal/optional-owners.ts")>(),
  assertFeaturePackages: vi.fn(),
}))

beforeEach(() => vi.mocked(assertFeaturePackages).mockClear())

it.each(["cts", "cjs"])("checks Content and all implicit CMS owners through a relative re-export in content.%s", async (extension) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-optional-cms-"))
  try {
    await mkdir(join(root, "server"))
    await writeFile(join(root, `server/content.${extension}`), 'export { content } from "./definition"\n')
    await writeFile(join(root, "server/definition.ts"), 'import { cms } from "vite-hub/cms"\nexport const content = { extends: cms }\n')
    await resolveConfig({ configFile: false, root, plugins: [optionalOwnerEntriesPlugin()] }, "build")
    expect(assertFeaturePackages).toHaveBeenLastCalledWith(["content", "cms", "database", "workspace"])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("includes Database in the first Comments package check", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-optional-comments-"))
  try {
    await mkdir(join(root, "server"))
    await writeFile(join(root, "server/comments.ts"), "export const comments = {}\n")
    await resolveConfig({ configFile: false, root, plugins: [optionalOwnerEntriesPlugin()] }, "build")
    expect(assertFeaturePackages).toHaveBeenLastCalledWith(["comments", "database"])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
