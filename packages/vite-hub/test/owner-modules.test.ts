import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, expect, it, vi } from "vitest"
import { resolveConfig } from "vite"

import { optionalOwnerEntriesPlugin, optionalOwnerImportsPlugin } from "../src/internal/owner-modules.ts"
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

it("checks the owner package of each vite-hub facade that the app imports", () => {
  const { resolveId } = optionalOwnerImportsPlugin()
  if (!resolveId || typeof resolveId !== "object" || !(resolveId.filter?.id instanceof RegExp)) throw new TypeError("Expected a filtered resolver")
  const { filter, handler } = resolveId
  const resolve = (source: string) => {
    if (filter.id instanceof RegExp && filter.id.test(source)) Reflect.apply(handler, {}, [source, undefined, {}])
  }
  for (const [source, feature] of [
    ["vite-hub/ui", "ui"],
    ["vite-hub/ui/avatar-stack", "ui"],
    ["vite-hub/ui/nuxt", "ui"],
    ["vite-hub/ui/styles.css", "ui"],
    ["vite-hub/presets/babysitter/server", "presets"],
    ["vite-hub/shell", "shell"],
    ["vite-hub/shell/workspace", "shell"],
  ] as const) {
    vi.mocked(assertFeaturePackages).mockClear()
    resolve(source)
    expect(assertFeaturePackages, source).toHaveBeenCalledExactlyOnceWith([feature])
  }
  vi.mocked(assertFeaturePackages).mockClear()
  for (const source of ["vite-hub", "vite-hub/blob", "vite-hub/uikit", "vite-hub/shells", "@vite-hub/ui", "./ui"]) resolve(source)
  expect(assertFeaturePackages).not.toHaveBeenCalled()
})
