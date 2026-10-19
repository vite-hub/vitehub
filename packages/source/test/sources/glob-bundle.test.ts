import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseAst } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { files } from "../../src/files.ts"
import { glob } from "../../src/glob.ts"
import { BUNDLED_GLOB_ID, collectBundledGlob, findGlobCalls, loadBundledGlob, renderBundledGlob, rewriteGlobCalls } from "../../src/internal/bundle-glob.ts"
import { resolveGlobInput } from "../../src/sources/glob.ts"

import type { FileSource } from "../../src/core/types.ts"

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function project() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-source-glob-bundle-"))
  tempDirs.push(root)
  const docs = join(root, "content/docs")
  await mkdir(join(docs, "guide"), { recursive: true })
  await mkdir(join(docs, "node_modules/pkg"), { recursive: true })
  await writeFile(join(docs, "index.md"), "# Home\n")
  await writeFile(join(docs, "guide/setup.md"), "# Setup — ✓\n")
  await writeFile(join(docs, "guide/draft.md"), "# Draft\n")
  await writeFile(join(docs, ".hidden.md"), "# Hidden\n")
  await writeFile(join(docs, "node_modules/pkg/readme.md"), "# Dependency\n")
  await writeFile(join(docs, "logo.png"), new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 255]))
  const outside = await mkdtemp(join(tmpdir(), "vitehub-source-glob-bundle-outside-"))
  tempDirs.push(outside)
  await writeFile(join(outside, "secret.md"), "secret")
  await symlink(join(outside, "secret.md"), join(docs, "linked.md"))
  return root
}

const parse = (code: string) => parseAst(code) as unknown as Parameters<typeof findGlobCalls>[0]

/** Every item a Source serves, as glob() and the bundle should agree on them. */
async function served(source: FileSource<string>, rootDir: string) {
  const ctx = { rootDir }
  const items = []
  for (const key of await source.getKeys(ctx)) {
    const item = await source.getItem(key, ctx).catch(() => undefined)
    if (item) items.push({ key, path: item.path, content: [...new Uint8Array(item.content as Uint8Array)] })
  }
  return items
}

describe("glob() patterns", () => {
  it("reads the folders before the first wildcard as cwd", () => {
    expect(resolveGlobInput("content/docs/**/*.md")).toEqual({ cwd: "content/docs", include: "**/*.md" })
    expect(resolveGlobInput("./docs/*.{md,mdx}")).toEqual({ cwd: "docs", include: "*.{md,mdx}" })
    expect(resolveGlobInput("**/*.md")).toEqual({ cwd: ".", include: "**/*.md" })
    expect(resolveGlobInput("content\\docs")).toEqual({ cwd: "content/docs", include: "**/*" })
    expect(resolveGlobInput({ include: "*.md", cwd: "docs" })).toEqual({ include: "*.md", cwd: "docs" })
  })

  it("serves the same keys from a pattern as from its options", async () => {
    const root = await project()
    const ctx = { rootDir: root }
    const keys = await glob("content/docs/**/*.md").getKeys(ctx)
    expect(keys).toEqual(["guide/draft.md", "guide/setup.md", "index.md"])
    expect(keys).toEqual(await glob({ cwd: "content/docs", include: "**/*.md" }).getKeys(ctx))
  })
})

describe("glob() bundled by the build", () => {
  it.each([
    ["a pattern", "content/docs/**/*"],
    ["ignore and prefix", { cwd: "content/docs", include: "**/*", ignore: "guide/draft.md", prefix: "docs" }],
    ["dot files", { cwd: "content/docs", include: "**/*.md", dot: true }],
    ["followed symbolic links", { cwd: "content/docs", include: "**/*.md", followSymlinks: true }],
  ] as const)("serves what glob() reads from disk, with %s", async (_name, input) => {
    const root = await project()
    const { entries, prefix } = await collectBundledGlob(input, root)
    const bundled = await served(files(entries, { prefix }), "/no-file-system")
    expect(bundled).toEqual(await served(glob(input), root))
    expect(bundled.length).toBeGreaterThan(0)
  })

  it("leaves out what glob() would not read: node_modules, dot files, links outside the root", async () => {
    const root = await project()
    const { entries } = await collectBundledGlob("content/docs/**/*.md", root)
    expect(Object.keys(entries)).toEqual(["guide/draft.md", "guide/setup.md", "index.md"])
  })

  it("generates a module that loads the same bytes, text and binary", async () => {
    const root = await project()
    const id = BUNDLED_GLOB_ID + encodeURIComponent(JSON.stringify({ filesModule: "vite-hub/source/files", input: "content/docs/**/*" }))
    const { code, watched } = await loadBundledGlob(id, root)
    expect(code.split("\n")[0]).toBe(`import { files } from "vite-hub/source/files"`)
    expect(code).toContain(`"index.md": text("# Home\\n")`)
    expect(code).toMatch(/"logo\.png": bytes\("[\w+/=]+"\)/)
    expect(watched).toContain(join(root, "content/docs/index.md"))

    const body = code.split("\n").slice(1).join("\n").replace("export default ", "return ")
    const source = new Function("files", body)(files) as FileSource<string>
    expect(await served(source, "/no-file-system")).toEqual(await served(glob("content/docs/**/*"), root))
  })
})

describe("glob() calls in a module", () => {
  it("finds calls by the names glob was imported under, with literal options", () => {
    const calls = findGlobCalls(parse(`
      import { glob, glob as g } from "vite-hub/source/glob"
      import { glob as other } from "./not-vitehub"
      const dir = "docs"
      export const a = glob("content/docs/**/*.md")
      export const b = g({ cwd: \`docs\`, include: ["**/*.md"], dot: true })
      export const c = glob({ cwd: dir, include: "**/*" })
      export const d = other("x/**")
    `))
    expect(calls.map(call => [call.input, call.filesModule])).toEqual([
      ["content/docs/**/*.md", "vite-hub/source/files"],
      [{ cwd: "docs", include: ["**/*.md"], dot: true }, "vite-hub/source/files"],
      [undefined, "vite-hub/source/files"],
    ])
  })

  it("swaps calls with literal options for their bundled module and leaves the others", () => {
    const code = `import { glob } from "@vite-hub/source/glob"\nconst dir = "docs"\nexport const a = glob("docs/**/*.md")\nexport const b = glob({ cwd: dir, include: "*" })\n`
    const output = rewriteGlobCalls(code, findGlobCalls(parse(code)))
    expect(output).toContain(`export const a = __vitehubGlob0\n`)
    expect(output).toContain(`export const b = glob({ cwd: dir, include: "*" })`)
    expect(output.split("\n")[0]).toBe(`import __vitehubGlob0 from ${JSON.stringify(BUNDLED_GLOB_ID + encodeURIComponent(JSON.stringify({ filesModule: "@vite-hub/source/files", input: "docs/**/*.md" })))};`)
  })

  it("ignores modules that do not import glob from ViteHub", () => {
    expect(findGlobCalls(parse(`export const a = glob("docs/**")`))).toEqual([])
  })
})

describe("files()", () => {
  it("puts prefix before every path, like glob()", async () => {
    await expect(files({ "a.md": "a" }, { prefix: "docs" }).getItem("a.md", { rootDir: "/" })).resolves.toMatchObject({ key: "a.md", path: "docs/a.md" })
  })
})

it("renders an empty match as an empty Source", async () => {
  const code = renderBundledGlob("vite-hub/source/files", {})
  const body = code.split("\n").slice(1).join("\n").replace("export default ", "return ")
  const source = new Function("files", body)(files) as FileSource<string>
  await expect(source.getKeys({ rootDir: "/" })).resolves.toEqual([])
})
