import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import {
  createProgram,
  flattenDiagnosticMessageText,
  getPreEmitDiagnostics,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
} from "typescript"
import { build } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { hubMarkdownTemplate } from "../src/vite.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-markdown-template-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("hubMarkdownTemplate", () => {
  it("bundles caller-relative templates as typed render functions", async () => {
    const root = await createRoot()
    const entry = join(root, "babysitter.schedule.ts")
    const template = join(root, "prompt.md")
    const partial = join(root, "context.md")
    const outfile = join(root, "dist", "schedule.mjs")
    await writeFile(template, "# Babysitter\n\n@./context.md.\n\n[Policy](@./missing.md)\n\n`@./missing.md`\n\n`multiline\n@./missing.md\ncode`\n\n> ~~~md\n> @./missing.md\n> ~~~~\n\n    @./missing.md\n\n- Example\n\n        @./missing.md\n\n- Fenced example\n    ```md\n    @./missing.md\n    ```\n\n- Context\n    @./context.md\n\n{{{ blocker }}}\n", "utf8")
    await writeFile(partial, "Review PR {{ context.number }}.", "utf8")
    await writeFile(entry, [
      `import prompt from "./prompt.md?markdown-template"`,
      `export default (): Promise<string> => prompt({ blocker: "> Waiting", context: { number: 42 } })`,
      ``,
    ].join("\n"), "utf8")

    await build({
      build: {
        emptyOutDir: true,
        lib: {
          entry,
          fileName: () => "schedule.mjs",
          formats: ["es"],
        },
        minify: false,
        outDir: join(root, "dist"),
      },
      logLevel: "silent",
      plugins: [hubMarkdownTemplate()],
      root,
    })

    await Promise.all([rm(template), rm(partial)])
    const bundled = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: () => Promise<string> }
    await expect(bundled.default()).resolves.toBe("# Babysitter\n\nReview PR 42..\n\n[Policy](@./missing.md)\n\n`@./missing.md`\n\n`multiline @./missing.md code`\n\n> ```md\n> @./missing.md\n> ```\n\n```\n@./missing.md\n```\n\n- Example\n  ```\n  @./missing.md\n  ```\n- Fenced example\n  ```md\n  @./missing.md\n  ```\n- Context\nReview PR 42.\n\n> Waiting")
    const typesPath = join(root, ".vitehub", "types", "markdown-template.d.ts")
    await expect(readFile(typesPath, "utf8")).resolves.toContain(`declare module "*?markdown-template"`)

    const program = createProgram({
      options: {
        module: ModuleKind.NodeNext,
        moduleResolution: ModuleResolutionKind.NodeNext,
        noEmit: true,
        strict: true,
        target: ScriptTarget.ES2022,
      },
      rootNames: [entry, typesPath],
    })
    expect(getPreEmitDiagnostics(program).map(diagnostic => flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  }, 15_000)

  it("fails the build when a bundled template import is missing", async () => {
    const root = await createRoot()
    const entry = join(root, "entry.ts")
    await writeFile(join(root, "prompt.md"), "@./missing.md\n", "utf8")
    await writeFile(entry, 'import prompt from "./prompt.md?markdown-template"\nexport default prompt\n', "utf8")

    await expect(build({
      build: { lib: { entry, formats: ["es"] }, outDir: join(root, "dist") },
      logLevel: "silent",
      plugins: [hubMarkdownTemplate()],
      root,
    })).rejects.toThrow("Could not resolve Markdown template import")
  })
})
