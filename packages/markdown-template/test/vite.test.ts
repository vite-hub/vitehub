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

  it("discovers named templates with generated autocomplete", async () => {
    const root = await createRoot()
    const templates = join(root, "server", "templates", "review")
    const entry = join(root, "entry.ts")
    const outfile = join(root, "dist", "entry.mjs")
    await mkdir(templates, { recursive: true })
    await writeFile(join(templates, "prompt.md"), "Review {{ repository }}.\n", "utf8")
    await writeFile(join(templates, "private.template.md"), "Private {{ repository }}.\n", "utf8")
    await writeFile(join(root, "server", "templates", "__proto__.md"), "Prototype-safe.\n", "utf8")
    await writeFile(entry, [
      `import { renderTemplate, type TemplateName } from "#vitehub/templates"`,
      `const name: TemplateName = "review/prompt"`,
      `function assertInvalidName(): void {`,
      `  // @ts-expect-error invalid template name`,
      `  void renderTemplate("missing")`,
      `}`,
      `void assertInvalidName`,
      `export default (): Promise<string> => renderTemplate(name, { repository: "ViteHub" })`,
      ``,
    ].join("\n"), "utf8")

    await build({
      build: {
        emptyOutDir: true,
        lib: { entry, fileName: () => "entry.mjs", formats: ["es"] },
        minify: false,
        outDir: join(root, "dist"),
      },
      logLevel: "silent",
      plugins: [hubMarkdownTemplate()],
      root,
    })

    const catalogTypesPath = join(root, ".vitehub", "types", "templates.d.ts")
    await expect(readFile(catalogTypesPath, "utf8")).resolves.toContain(`export type TemplateName = "__proto__" | "review/prompt"`)
    await expect(readFile(catalogTypesPath, "utf8")).resolves.not.toContain("private")
    const catalogPath = join(root, ".vitehub", "markdown-template", "templates.mjs")
    await expect(readFile(catalogPath, "utf8")).resolves.toContain("Review {{ repository }}.")
    await expect(readFile(catalogPath, "utf8")).resolves.toContain("Prototype-safe.")
    await expect(readFile(catalogPath, "utf8")).resolves.not.toContain("Private {{ repository }}.")

    const program = createProgram({
      options: {
        module: ModuleKind.NodeNext,
        moduleResolution: ModuleResolutionKind.NodeNext,
        noEmit: true,
        strict: true,
        target: ScriptTarget.ES2022,
      },
      rootNames: [entry, catalogTypesPath],
    })
    expect(getPreEmitDiagnostics(program).map(diagnostic => flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])

    await rm(join(root, "server"), { force: true, recursive: true })
    const bundled = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: () => Promise<string> }
    await expect(bundled.default()).resolves.toBe("Review ViteHub.")
  }, 15_000)

  it("uses the project root when Vite runs from app", async () => {
    const root = await createRoot()
    const app = join(root, "app")
    const templates = join(root, "server", "templates")
    await mkdir(app, { recursive: true })
    await mkdir(templates, { recursive: true })
    await writeFile(join(app, "package.json"), "{}", "utf8")
    await writeFile(join(templates, "prompt.md"), "Hello.", "utf8")
    await writeFile(join(app, "entry.ts"), 'export { renderTemplate } from "#vitehub/templates"\n', "utf8")

    await build({
      build: { lib: { entry: join(app, "entry.ts"), formats: ["es"] }, outDir: join(app, "dist") },
      logLevel: "silent",
      plugins: [hubMarkdownTemplate()],
      root: app,
    })

    await expect(readFile(join(root, ".vitehub", "types", "templates.d.ts"), "utf8"))
      .resolves.toContain('export type TemplateName = "prompt"')
    await expect(readFile(join(root, ".vitehub", "markdown-template", "templates.mjs"), "utf8"))
      .resolves.toContain("Hello.")
  }, 15_000)

  it("keeps a standalone app directory as the project root", async () => {
    const parent = await createRoot()
    const root = join(parent, "app")
    const templates = join(root, "server", "templates")
    await mkdir(templates, { recursive: true })
    await writeFile(join(root, "package.json"), "{}", "utf8")
    await writeFile(join(templates, "prompt.md"), "Hello.", "utf8")
    await writeFile(join(root, "entry.ts"), 'export { renderTemplate } from "#vitehub/templates"\n', "utf8")

    await build({
      build: { lib: { entry: join(root, "entry.ts"), formats: ["es"] }, outDir: join(root, "dist") },
      logLevel: "silent",
      plugins: [hubMarkdownTemplate()],
      root,
    })

    await expect(readFile(join(root, ".vitehub", "types", "templates.d.ts"), "utf8"))
      .resolves.toContain('export type TemplateName = "prompt"')
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
