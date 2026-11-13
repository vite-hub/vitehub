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
    await writeFile(join(root, `server/content.${extension}`), 'export { default } from "./definition"\n')
    await writeFile(join(root, "server/definition.ts"), 'import { cms } from "vite-hub/cms"\nexport default { extends: cms }\n')
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

it.each([undefined, false])("checks Forms with database: %s", async (database) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-optional-forms-"))
  try {
    await mkdir(join(root, "server/forms"), { recursive: true })
    await writeFile(join(root, "server/forms/contact.ts"), "export default {}\n")
    await resolveConfig({ configFile: false, root, plugins: [optionalOwnerEntriesPlugin({ database })] }, "build")
    expect(assertFeaturePackages).toHaveBeenLastCalledWith(database === false ? ["forms"] : ["forms", "database"])
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
    ["vite-hub/ui/headless", "ui"],
    ["vite-hub/ui/styles.css", "ui"],
    ["vite-hub/presets/babysitter/server", "presets"],
    ["vite-hub/shell", "shell"],
    ["vite-hub/shell/workspace", "shell"],
    ["vite-hub/forge", "forge"],
    ["vite-hub/console/ui", "console ui"],
    ["vite-hub/blob", "blob"],
    ["vite-hub/blob/vue", "blob"],
    ["vite-hub/browser", "browser"],
    ["vite-hub/channels", "channels"],
    ["vite-hub/connections/google", "connections"],
    ["vite-hub/decisions/vue", "decisions"],
    ["vite-hub/email/server", "email"],
    ["vite-hub/gateways/ai-sdk", "gateways"],
    ["vite-hub/kv", "kv"],
    ["vite-hub/markdown-template", "markdown-template"],
    ["/app/server/emails/welcome.template.md", "markdown-template"],
    ["vite-hub/queue", "queue"],
    ["vite-hub/rate-limit", "rateLimit"],
    ["vite-hub/sandbox/task", "sandboxTask"],
    ["vite-hub/workflow", "workflow"],
  ] as const) {
    vi.mocked(assertFeaturePackages).mockClear()
    resolve(source)
    expect(assertFeaturePackages, source).toHaveBeenCalledExactlyOnceWith([feature])
  }
  vi.mocked(assertFeaturePackages).mockClear()
  for (const source of ["vite-hub", "vite-hub/blobs", "vite-hub/env", "vite-hub/runtime", "vite-hub/source", "vite-hub/uikit", "vite-hub/shells", "vite-hub/forges", "vite-hub/console", "vite-hub/console/uikit", "@vite-hub/forge", "@vite-hub/ui", "@vite-hub/kv", "./ui", "./notes.md", "/app/welcome.template.md?raw"]) resolve(source)
  expect(assertFeaturePackages).not.toHaveBeenCalled()
})
