import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { createProgram, flattenDiagnosticMessageText, getPreEmitDiagnostics, ModuleKind, ModuleResolutionKind, ScriptTarget } from "typescript"
import { afterEach, describe, expect, it } from "vitest"

const tempDirs: string[] = []
const packageRoot = resolve(import.meta.dirname, "..")

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe.each(["src/index.ts", "dist/index.d.ts", "src/runtime/registry.ts"])("useDatabase types from %s", (entry) => {
  it.each([
    { names: ["default", "analytics"], selected: "default" },
    { names: ["analytics"], selected: "analytics" },
    { names: ["analytics", "reports"], selected: undefined },
    { names: [], selected: undefined },
  ])("matches omitted and explicit lookups for $names", async ({ names, selected }) => {
    const baseDir = resolve(packageRoot, "../../.vitest-tmp")
    await mkdir(baseDir, { recursive: true })
    const root = await mkdtemp(join(baseDir, "database-lookup-types-"))
    tempDirs.push(root)
    const file = join(root, "lookup.ts")
    await writeFile(file, [
      "import { useDatabase } from '@vite-hub/database'",
      "declare module '@vite-hub/database' {",
      "  interface DatabaseRegistry {",
      ...names.map(name => `    ${name}: { schema: { marker: '${name}' } }`),
      "  }",
      "}",
      ...names.flatMap(name => [
        `export const ${name}Marker: '${name}' = useDatabase('${name}').schema.marker`,
        `export const ${name}Generic: '${name}' = useDatabase<'${name}'>('${name}').schema.marker`,
        ...(name === selected
          ? [`export const ${name}Omitted: '${name}' = useDatabase<'${name}'>().schema.marker`]
          : ["// @ts-expect-error A different Database requires the runtime name.", `useDatabase<'${name}'>()`]),
      ]),
      ...(selected
        ? [`export const selected: '${selected}' = useDatabase().schema.marker`]
        : ["// @ts-expect-error An ambiguous or empty registry requires a name.", "useDatabase()"]),
      "// @ts-expect-error Unknown names cannot select a Database.",
      "useDatabase('missing')",
      "",
    ].join("\n"))
    const program = createProgram({
      options: {
        allowImportingTsExtensions: true,
        module: ModuleKind.ESNext,
        moduleResolution: ModuleResolutionKind.Bundler,
        noEmit: true,
        paths: {
          "@vite-hub/database": [join(packageRoot, entry)],
          "@vite-hub/database/runtime/registry": [join(packageRoot, entry.startsWith("dist/") ? "dist/runtime/registry.d.ts" : "src/runtime/registry.ts")],
        },
        skipLibCheck: true,
        strict: true,
        target: ScriptTarget.ES2022,
        types: ["node"],
      },
      rootNames: [file, join(packageRoot, "src/virtual-module.d.ts")],
    })
    expect(getPreEmitDiagnostics(program).map(diagnostic => ({
      file: diagnostic.file?.fileName,
      line: diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : undefined,
      message: flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    }))).toEqual([])
  }, 60_000)
})
