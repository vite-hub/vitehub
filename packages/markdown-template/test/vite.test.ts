import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

import { extractMarkdownTemplateImportSpecifiers, markdownTemplateMaterializationPath, parseMarkdownTemplateRequest } from "../src/internal/vite.ts"
import { hubMarkdownTemplate } from "../src/vite.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-markdown-template-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), "{}", "utf8")
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("hubMarkdownTemplate", () => {
  it("derives safe materialization paths from template names", () => {
    expect(markdownTemplateMaterializationPath("./PULL_REQUEST.template.md")).toBe("PULL_REQUEST.md")
    expect(markdownTemplateMaterializationPath("./review/PULL_REQUEST.template.md")).toBe("review/PULL_REQUEST.md")
    for (const path of [
      "/PULL_REQUEST.template.md",
      "../PULL_REQUEST.template.md",
      "./review/../PULL_REQUEST.template.md",
      "./PULL_REQUEST.md",
      ".\\PULL_REQUEST.template.md",
    ]) {
      expect(() => markdownTemplateMaterializationPath(path)).toThrow("Markdown materialization")
    }
  })

  it("leaves explicit Vite queries on direct templates untouched", () => {
    expect(parseMarkdownTemplateRequest("./prompt.template.md?raw")).toBeUndefined()
    expect(parseMarkdownTemplateRequest("./prompt.template.md?url")).toBeUndefined()
    expect(parseMarkdownTemplateRequest("./prompt.template.md?markdown-template")).toEqual({ path: "./prompt.template.md" })
  })

  it("extracts imports from indented paragraph continuations", () => {
    expect(extractMarkdownTemplateImportSpecifiers("Intro\n    @./context.md\n")).toEqual(["./context.md"])
    expect(extractMarkdownTemplateImportSpecifiers("    @./example.md\n")).toEqual([])
  })

  it("bundles caller-relative templates as typed render functions", async () => {
    const root = await createRoot()
    const entry = join(root, "babysitter.schedule.ts")
    const template = join(root, "prompt.template.md")
    const partial = join(root, "context.md")
    const outfile = join(root, "dist", "schedule.mjs")
    await writeFile(template, "# Babysitter\n\n@./context.md.\n\n[Policy](@./missing.md)\n\n`@./missing.md`\n\n`multiline\n@./missing.md\ncode`\n\n> ~~~md\n> @./missing.md\n> ~~~~\n\n    @./missing.md\n\n- Example\n\n        @./missing.md\n\n- Fenced example\n    ```md\n    @./missing.md\n    ```\n\n- Context\n    @./context.md\n\n{{{ blocker }}}\n", "utf8")
    await writeFile(partial, "Review PR {{ context.number }}.", "utf8")
    await writeFile(entry, [
      `import prompt from "./prompt.template.md"`,
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
    await expect(readFile(typesPath, "utf8")).resolves.toContain(`declare module "*.template.md"`)

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

  it("writes direct-import types at the project root when Vite runs from app", async () => {
    const root = await createRoot()
    const app = join(root, "app")
    await mkdir(app, { recursive: true })
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await mkdir(join(root, ".vitehub", "markdown-template"), { recursive: true })
    await mkdir(join(root, ".vitehub", "types"), { recursive: true })
    await writeFile(join(app, "package.json"), "{}", "utf8")
    await writeFile(join(app, "prompt.template.md"), "Hello {{ name }}.", "utf8")
    await writeFile(join(root, ".vitehub", "markdown-template", "templates.mjs"), "stale catalog", "utf8")
    await writeFile(join(root, ".vitehub", "types", "templates.d.ts"), "stale catalog types", "utf8")
    await writeFile(join(app, "entry.ts"), [
      `import prompt from "./prompt.template.md"`,
      `export default () => prompt({ name: "ViteHub" })`,
      ``,
    ].join("\n"), "utf8")

    await build({
      build: {
        lib: { entry: join(app, "entry.ts"), fileName: () => "entry.mjs", formats: ["es"] },
        outDir: join(app, "dist"),
      },
      logLevel: "silent",
      plugins: [hubMarkdownTemplate()],
      root: app,
    })

    await expect(readFile(join(root, ".vitehub", "types", "markdown-template.d.ts"), "utf8"))
      .resolves.toContain('declare module "*.template.md"')
    await expect(readFile(join(root, ".vitehub", "markdown-template", "templates.mjs"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, ".vitehub", "types", "templates.d.ts"), "utf8")).rejects.toThrow()
    const bundled = await import(`${pathToFileURL(join(app, "dist", "entry.mjs")).href}?t=${Date.now()}`) as { default: () => Promise<string> }
    await expect(bundled.default()).resolves.toBe("Hello ViteHub.")
  }, 15_000)

  it("fails the build when a bundled template import is missing", async () => {
    const root = await createRoot()
    const entry = join(root, "entry.ts")
    await writeFile(join(root, "prompt.template.md"), "@./missing.md\n", "utf8")
    await writeFile(entry, 'import prompt from "./prompt.template.md"\nexport default prompt\n', "utf8")

    await expect(build({
      build: { lib: { entry, formats: ["es"] }, outDir: join(root, "dist") },
      logLevel: "silent",
      plugins: [hubMarkdownTemplate()],
      root,
    })).rejects.toThrow("Could not resolve Markdown template import")
  })
})
