import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix, win32 } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

const directories: string[] = []

afterEach(async () => {
  vi.doUnmock("node:path")
  vi.resetModules()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it.each([
  {
    name: "Windows drive",
    from: String.raw`C:\app\.vitehub`,
    to: String.raw`D:\api\.vitehub\types\connections.d.ts`,
    expected: "D:/api/.vitehub/types/connections.d.ts",
    paths: win32,
  },
  {
    name: "UNC host",
    from: String.raw`\\server\app\.vitehub`,
    to: String.raw`\\other\api\.vitehub\types\connections.d.ts`,
    expected: "//other/api/.vitehub/types/connections.d.ts",
    paths: win32,
  },
  {
    name: "same UNC host",
    from: String.raw`\\server\app\.vitehub`,
    to: String.raw`\\server\api\.vitehub\types\connections.d.ts`,
    expected: "./../../api/.vitehub/types/connections.d.ts",
    paths: win32,
  },
  {
    name: "same Windows drive",
    from: String.raw`C:\app\.vitehub`,
    to: String.raw`C:\api\.vitehub\types\connections.d.ts`,
    expected: "./../../api/.vitehub/types/connections.d.ts",
    paths: win32,
  },
  {
    name: "POSIX",
    from: "/app/.vitehub",
    to: "/api/.vitehub/types/connections.d.ts",
    expected: "./../../api/.vitehub/types/connections.d.ts",
    paths: posix,
  },
])("writes normalized aggregate references across $name roots", async ({ from, to, expected, paths }) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-reference-root-"))
  const extraRoot = await mkdtemp(join(tmpdir(), "vitehub-reference-extra-"))
  directories.push(root, extraRoot)
  const defaultDirectory = join(root, ".vitehub")
  const extraDeclaration = join(extraRoot, ".vitehub/types/connections.d.ts")
  await Promise.all([
    mkdir(join(defaultDirectory, "env"), { recursive: true }),
    mkdir(join(extraRoot, ".vitehub/types"), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(defaultDirectory, "env/env.d.ts"), "interface ImportMetaEnv {}\n"),
    writeFile(extraDeclaration, "export {}\n"),
  ])
  vi.doMock("node:path", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:path")>()
    return {
      ...actual,
      relative(source: string, target: string) {
        return source === defaultDirectory && target === extraDeclaration
          ? paths.relative(from, to)
          : actual.relative(source, target)
      },
      isAbsolute(value: string) {
        return actual.isAbsolute(value) || paths.isAbsolute(value)
      },
    }
  })
  const { viteHubTypesPlugin } = await import("../src/internal/types.ts")
  await viteHubTypesPlugin().api.prepareTypes({ additionalProjectRoots: [extraRoot], projectRoot: root })
  expect(await readFile(join(defaultDirectory, "types.d.ts"), "utf8")).toBe(
    `/// <reference path="${expected}" />\n/// <reference path="./env/env.d.ts" />\n\nexport {}\n`,
  )
})
