import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { resolveSandboxProject } from "../src/project.ts"
import { bundleSandboxDefinition } from "../src/bundle.ts"
import { executeSandboxDefinition } from "../src/runtime/execute.ts"
import { createSandboxExecutionBox } from "../src/runtime/execution-box.ts"
import { resolveBox } from "@vite-hub/box"

const roots: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-project-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("resolveSandboxProject", () => {
  it("includes pnpm patch files from the install root", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/task")
    await mkdir(join(root, "patches"), { recursive: true })
    await mkdir(sandbox, { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.33.0",
      pnpm: { patchedDependencies: { kleur: "patches/kleur.patch" } },
      private: true,
    }))
    await writeFile(join(root, "patches/kleur.patch"), "patched dependency\n")
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({ name: "task", private: true, type: "module" }))
    await writeFile(join(sandbox, "index.ts"), "export default null\n")

    const project = await resolveSandboxProject(join(sandbox, "index.ts"), root)

    expect(project.files["patches/kleur.patch"]).toMatchObject({ encoding: "base64" })
  })

  it("includes pnpm patch files declared by the workspace", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/task")
    await mkdir(join(root, "patches"), { recursive: true })
    await mkdir(sandbox, { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.33.0", private: true }))
    await writeFile(join(root, "patches/kleur.patch"), "patched dependency\n")
    await writeFile(join(root, "pnpm-workspace.yaml"), [
      "packages: ['sandboxes/*']",
      "patchedDependencies:",
      "  'kleur@4.1.5': patches/kleur.patch",
      "",
    ].join("\n"))
    await writeFile(join(sandbox, "package.json"), JSON.stringify({ name: "task", private: true, type: "module" }))
    await writeFile(join(sandbox, "index.ts"), "export default null\n")

    const project = await resolveSandboxProject(join(sandbox, "index.ts"), root)

    expect(project.files["patches/kleur.patch"]).toMatchObject({ encoding: "base64" })
  })

  it("reads timeout from package metadata for executable entries", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      vitehub: { sandbox: { timeout: 60_000 } },
    }))
    await writeFile(entry, "export default null")

    const project = await resolveSandboxProject(entry, root, { readSandboxOptions: true })

    expect(project.options).toEqual({ timeout: 60_000 })
  })

  it("requires canonical package entrypoints to declare ESM semantics", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(entry, "export default null\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('must set "type" to "module"')
  })

  it.each(["cjs", "cts"])("rejects local CommonJS .%s modules", async (extension) => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, `helper.${extension}`), "export default true\n")
    await writeFile(entry, `import helper from './helper.${extension}'\nexport default helper\n`)
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow(`imports CommonJS module "./helper.${extension}"`)
  })

  it.each([
    ["const helper = require('./helper.js')\nexport default helper\n", "require()"],
    ["const target = './helper.js'\nconst helper = require(target)\nexport default helper\n", "require()"],
    ["const path = require.resolve('./helper.js')\nexport default path\n", "require.resolve"],
    ["module.exports = { helper: true }\n", "module.exports assignment"],
    ["exports.helper = true\n", "exports assignment"],
    ["Object.defineProperty(exports, '__esModule', { value: true })\n", "exports reference"],
    ["Object.assign(module.exports, { helper: true })\n", "module reference"],
    ["import type { exports } from './types.d.ts'\nObject.assign(exports, { helper: true })\n", "exports reference"],
    ["declare const module: { exports: unknown }\nObject.assign(module.exports, { helper: true })\n", "module reference"],
    ["declare function require(id: string): unknown\nexport default require('helper')\n", "require()"],
    ["import helper = require('./helper.js')\nexport default helper\n", "import = require()"],
    ["for (const require of []) void require\nexport default require('helper')\n", "require()"],
    ["for (const key in {}) { const exports = key; void exports }\nexport default exports\n", "exports reference"],
    ["for (let module = 0; module < 1; module++) {}\nexport default module\n", "module reference"],
    ["switch (true) { case true: { const exports = true; void exports; break } }\nexport default exports\n", "exports reference"],
    ["class Value { static { var require = (value: string) => value; require('ok') } }\nexport default require('helper')\n", "require()"],
    ["export default { module }\n", "module reference"],
    ["export { module as value }\n", "module reference"],
    ["const Value = class module { static self = module }\nexport default module\n", "module reference"],
    ["const { value = module } = {}\nexport default value\n", "module reference"],
    ["const [value = exports] = []\nexport default value\n", "exports reference"],
    ["const { value: { nested = module } = {} } = {}\nexport default nested\n", "module reference"],
  ])("rejects CommonJS package syntax", async (contents, syntax) => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, "helper.js"), "export default true\n")
    await writeFile(join(root, "types.d.ts"), "export interface exports {}\n")
    await writeFile(entry, contents)
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow(`uses CommonJS ${syntax}`)
  })

  it("allows locally bound CommonJS-like identifiers", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(entry, [
      "const require = (value: string) => value",
      "const module = { exports: true }",
      "const exports = { helper: true }",
      "export default { exports, module: module.exports, value: require('ok') }",
      "",
    ].join("\n"))
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).resolves.toMatchObject({ entry: "index.ts.mjs" })
  })

  it("allows CommonJS-like type and class property names", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(entry, [
      "interface SandboxPayload { module: string; exports: string }",
      "class Result { module = 'esm'; exports = 'value' }",
      "const { module: kind, exports: value } = new Result()",
      "module: { if (kind) break module }",
      "export default { module: kind, exports: value } satisfies SandboxPayload",
      "",
    ].join("\n"))
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).resolves.toMatchObject({ entry: "index.ts.mjs" })
  })

  it.each([
    [
      "class expression self binding",
      "const Value = class module { static self = module }\nexport default Value\n",
    ],
    [
      "enum runtime binding",
      "enum module { value = 'esm' }\nexport default module.value\n",
    ],
    [
      "namespace runtime binding",
      "namespace module { export const value = 'esm' }\nexport default module.value\n",
    ],
    [
      "erased type export",
      "type module = string\nexport type { module }\nexport default true\n",
    ],
    [
      "erased inline type export",
      "type module = string\nexport { type module }\nexport default true\n",
    ],
    [
      "runtime import alias",
      "import { module as value } from './source.js'\nexport default value\n",
    ],
    [
      "runtime re-export alias",
      "export { module as value } from './source.js'\nexport default true\n",
    ],
    [
      "exported name alias",
      "const value = true\nexport { value as module }\nexport default value\n",
    ],
    [
      "destructuring property names",
      "const { module: value, exports: other } = { module: true, exports: true }\nexport default value && other\n",
    ],
    [
      "statement labels",
      "module: { break module }\nexport default true\n",
    ],
    [
      "loop-local binding",
      "for (const require of ['ok']) require.toUpperCase()\nexport default true\n",
    ],
    [
      "switch-local binding",
      "switch (true) { case true: { const exports = true; void exports; break } }\nexport default true\n",
    ],
    [
      "class static block binding",
      "class Value { static { var require = (value: string) => value; require('ok') } }\nexport default Value\n",
    ],
    [
      "delayed destructuring self-capture",
      "const { module = () => module } = {}\nexport default module()\n",
    ],
  ])("allows %s in emitted package modules", async (_name, contents) => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, "source.js"), "export const module = 'esm'\n")
    await writeFile(entry, contents)
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).resolves.toMatchObject({ entry: "index.ts.mjs" })
  })

  it("rejects non-literal dynamic imports", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, "helper.ts"), "export default true\n")
    await writeFile(entry, "const extension = 'ts'\nexport default await import('./helper.' + extension)\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow("uses a non-literal dynamic import")
  })

  it("rejects zero-argument dynamic imports with the package diagnostic", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(entry, "export default import()\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow("uses a non-literal dynamic import")
  })

  it.each([
    ["/tmp/outside.mjs"],
    ["file:///tmp/outside.mjs"],
    ["data:text/javascript,export default true"],
  ])("rejects absolute and URL package imports from %s", async (specifier) => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(entry, `import value from ${JSON.stringify(specifier)}\nexport default value\n`)
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow(`imports absolute or URL module "${specifier}"`)
  })

  it.each([
    ["#helper", "imports package alias"],
    ["@fixture/sandbox/helper", "self-imports"],
  ])("rejects project-local package indirection through %s", async (specifier, message) => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({
      imports: { "#helper": "./helper.ts" },
      name: "@fixture/sandbox",
      private: true,
      type: "module",
    }))
    await writeFile(join(root, "helper.ts"), "export default true\n")
    await writeFile(entry, `import helper from ${JSON.stringify(specifier)}\nexport default helper\n`)
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow(message)
  })

  it("rejects relative imports that escape the selected package", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({ exports: "./index.js", name: "@fixture/helper", type: "module" }))
    await writeFile(join(helper, "index.js"), "export default true\n")
    await writeFile(join(helper, "index.ts"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '../../packages/helper/index.ts'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('imports "../../packages/helper/index.ts" outside its package')
  })

  it("rejects TypeScript runtime exports from captured workspace dependencies", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    const fixture = join(sandbox, "fixtures/helper")
    await Promise.all([
      mkdir(fixture, { recursive: true }),
      mkdir(helper, { recursive: true }),
    ])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({
      exports: { import: { types: "./index.d.ts" }, default: "./index.ts" },
      name: "@fixture/helper",
      type: "module",
    }))
    await writeFile(join(helper, "index.d.ts"), "declare const value: true\nexport default value\n")
    await writeFile(join(helper, "index.ts"), "export default true\n")
    await writeFile(join(fixture, "package.json"), JSON.stringify({
      exports: "./index.js",
      name: "@fixture/helper",
      type: "module",
    }))
    await writeFile(join(fixture, "index.js"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('workspace dependency "@fixture/helper" exposes TypeScript runtime target "./index.ts"')
  })

  it("rejects TypeScript edges behind workspace JavaScript exports", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({
      exports: "./index.js",
      name: "@fixture/helper",
      type: "module",
    }))
    await writeFile(join(helper, "index.js"), "import value from './helper.ts'\nexport default value\n")
    await writeFile(join(helper, "helper.ts"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('workspace dependency "@fixture/helper" exposes TypeScript runtime target "./helper.ts"')
  })

  it("rejects TypeScript workspace package import aliases", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({
      exports: "./index.js",
      imports: { "#internal": "./helper.ts" },
      name: "@fixture/helper",
      type: "module",
    }))
    await writeFile(join(helper, "index.js"), "export { default } from '#internal'\n")
    await writeFile(join(helper, "helper.ts"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('workspace dependency "@fixture/helper" exposes TypeScript runtime target "./helper.ts" through package import "#internal"')
  })

  it("rejects TypeScript workspace subpaths imported by dependency JavaScript", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const first = join(root, "packages/first")
    const second = join(root, "packages/second")
    await Promise.all([
      mkdir(sandbox, { recursive: true }),
      mkdir(first, { recursive: true }),
      mkdir(join(second, "src"), { recursive: true }),
    ])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/first": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(first, "package.json"), JSON.stringify({
      dependencies: { "@fixture/second": "workspace:*" },
      exports: "./index.js",
      name: "@fixture/first",
      type: "module",
    }))
    await writeFile(join(first, "index.js"), "export { default } from '@fixture/second/source'\n")
    await writeFile(join(second, "package.json"), JSON.stringify({
      exports: { "./source": "./src/source.ts" },
      name: "@fixture/second",
      type: "module",
    }))
    await writeFile(join(second, "src/source.ts"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/first'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('workspace dependency "@fixture/second" exposes TypeScript runtime target "./src/source.ts"')
  })

  it("validates the default index.js workspace entry", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({
      name: "@fixture/helper",
      type: "module",
    }))
    await writeFile(join(helper, "index.js"), "export { default } from './helper.ts'\n")
    await writeFile(join(helper, "helper.ts"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('workspace dependency "@fixture/helper" exposes TypeScript runtime target "./helper.ts"')
  })

  it("continues past invalid workspace export array targets", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({
      exports: ["invalid-target", "./index.ts"],
      name: "@fixture/helper",
      type: "module",
    }))
    await writeFile(join(helper, "index.ts"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('workspace dependency "@fixture/helper" exposes TypeScript runtime target "./index.ts"')
  })

  it("rejects TypeScript runtime exports from the pnpm workspace root", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    await mkdir(sandbox, { recursive: true })
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['.', 'sandboxes/*']\n")
    await writeFile(join(root, "package.json"), JSON.stringify({
      exports: "./index.ts",
      name: "@fixture/root",
      private: true,
      type: "module",
    }))
    await writeFile(join(root, "index.ts"), "export default true\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/root": "workspace:*" },
      private: true,
      type: "module",
    }))
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/root'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('workspace dependency "@fixture/root" exposes TypeScript runtime target "./index.ts"')
  })

  it("rejects TypeScript package subpath imports", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({ name: "@fixture/helper", type: "module" }))
    await writeFile(join(helper, "index.ts"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper/index.ts'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('workspace dependency "@fixture/helper" exposes TypeScript runtime target "./index.ts"')
  })

  it("allows TypeScript-named package subpaths that export runtime JavaScript", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({
      exports: { "./*.ts": "./dist/*.js" },
      name: "@fixture/helper",
      type: "module",
    }))
    await mkdir(join(helper, "dist"))
    await writeFile(join(helper, "dist/index.js"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper/index.ts'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).resolves.toMatchObject({ entry: "sandboxes/image/index.ts.mjs" })
  })

  it("rejects TypeScript runtime targets selected by workspace export patterns", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({
      exports: { "./*": "./src/*.ts" },
      name: "@fixture/helper",
      type: "module",
    }))
    await mkdir(join(helper, "src"))
    await writeFile(join(helper, "src/value.ts"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper/value'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('workspace dependency "@fixture/helper" exposes TypeScript runtime target "./src/value.ts"')
  })

  it("erases named type-only imports and exports without treating them as runtime edges", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, "types.d.ts"), "export interface Input { ok: boolean }\n")
    await writeFile(entry, [
      "import { type Input } from './types.d.ts'",
      "export { type Input as Output } from './types.d.ts'",
      "const value: Input = { ok: true }",
      "export default value",
      "",
    ].join("\n"))
    const project = await resolveSandboxProject(entry, root)
    const bundle = await bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })
    const output = Buffer.from(bundle.project!.files["index.ts.mjs"]!.contents, "base64").toString()
    expect(output).not.toContain("types.d.ts")
    expect(output).toContain("export default value")
  })

  it("does not reject unused workspace development dependencies with TypeScript exports", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      devDependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({ exports: "./index.ts", name: "@fixture/helper", type: "module" }))
    await writeFile(join(helper, "index.ts"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "export default true\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).resolves.toMatchObject({ entry: "sandboxes/image/index.ts.mjs" })
  })

  it("rejects imported workspace development dependencies with TypeScript exports", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      devDependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({
      exports: "./index.ts",
      name: "@fixture/helper",
      type: "module",
    }))
    await writeFile(join(helper, "index.ts"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('workspace dependency "@fixture/helper" exposes TypeScript runtime target "./index.ts"')
  })

  it("ignores unrelated package manifests outside the runtime dependency graph", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await Promise.all([
      mkdir(join(root, "fixtures/invalid"), { recursive: true }),
      mkdir(join(root, "fixtures/null"), { recursive: true }),
      mkdir(join(root, "fixtures/sharp"), { recursive: true }),
    ])
    await writeFile(join(root, "package.json"), JSON.stringify({
      dependencies: { sharp: "^0.34.0" },
      private: true,
      type: "module",
    }))
    await writeFile(join(root, "fixtures/invalid/package.json"), "not json")
    await writeFile(join(root, "fixtures/null/package.json"), "null")
    await writeFile(join(root, "fixtures/sharp/package.json"), JSON.stringify({
      exports: "./index.ts",
      name: "sharp",
      type: "module",
    }))
    await writeFile(entry, "import sharp from 'sharp'\nexport default sharp\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).resolves.toMatchObject({ entry: "index.ts.mjs" })
  })

  it("prefers workspace exports over an ignored TypeScript main field", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({
      exports: "./dist/index.js",
      main: "./src/index.ts",
      name: "@fixture/helper",
      type: "module",
    }))
    await mkdir(join(helper, "dist"))
    await writeFile(join(helper, "dist/index.js"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).resolves.toMatchObject({ entry: "sandboxes/image/index.ts.mjs" })
  })

  it("ignores inactive TypeScript workspace export conditions", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({
      exports: { development: "./src/index.ts", default: "./dist/index.js" },
      name: "@fixture/helper",
      type: "module",
    }))
    await mkdir(join(helper, "dist"))
    await mkdir(join(helper, "src"))
    await writeFile(join(helper, "dist/index.js"), "export default true\n")
    await writeFile(join(helper, "src/index.ts"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).resolves.toMatchObject({ entry: "sandboxes/image/index.ts.mjs" })
  })

  it("rejects TypeScript workspace exports selected by module-sync", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const helper = join(root, "packages/helper")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(helper, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
      type: "module",
    }))
    await writeFile(join(helper, "package.json"), JSON.stringify({
      exports: { "module-sync": "./index.ts", default: "./dist/index.js" },
      name: "@fixture/helper",
      type: "module",
    }))
    await writeFile(join(helper, "index.ts"), "export default true\n")
    await mkdir(join(helper, "dist"))
    await writeFile(join(helper, "dist/index.js"), "export default true\n")
    const entry = join(sandbox, "index.ts")
    await writeFile(entry, "import helper from '@fixture/helper'\nexport default helper\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('workspace dependency "@fixture/helper" exposes TypeScript runtime target "./index.ts"')
  })

  it("rejects package imports that Node cannot resolve directly", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, "helper.ts"), "export const ok = true\n")
    await writeFile(join(root, "unused.ts"), "export { missing } from './missing'\n")
    await writeFile(entry, "import { ok } from './helper'\nexport default { ok }\n")

    const project = await resolveSandboxProject(entry, root)

    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('imports "./helper", which is not an executable package file')
  })

  it.each(["jsx", "tsx"])("rejects package %s imports that Node cannot execute directly", async (extension) => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, `helper.${extension}`), "export const element = <div />\n")
    await writeFile(entry, `import { element } from './helper.${extension}'\nexport default element\n`)

    const project = await resolveSandboxProject(entry, root)

    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow(`imports JSX module "./helper.${extension}"`)
  })

  it("rejects package files that conflict with generated executables", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, "index.ts.mjs"), "export default 'existing'\n")
    await writeFile(entry, "export default 'source'\n")
    const project = await resolveSandboxProject(entry, root)
    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('module "index.ts" conflicts with generated executable "index.ts.mjs"')
  })

  it("ignores invalid imports outside the executable package graph", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, "unused.ts"), "export { missing } from './missing'\n")
    await writeFile(entry, "export default { ok: true }\n")

    const project = await resolveSandboxProject(entry, root)

    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).resolves.toMatchObject({ entry: "index.ts.mjs", execution: "module" })
  })

  it.each([
    [{ timeout: 0 }, "positive integer"],
    [{ timeout: 1.5 }, "positive integer"],
    [{ timeout: 2_147_483_648 }, "positive integer"],
    [{ env: { MODE: "test" } }, "unsupported keys: env"],
  ])("rejects invalid package Sandbox metadata", async (sandboxOptions, message) => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      vitehub: { sandbox: sandboxOptions },
    }))
    await writeFile(entry, "export default null")

    await expect(resolveSandboxProject(entry, root, { readSandboxOptions: true }))
      .rejects.toThrow(message)
  })

  it("resolves independent nearest package roots", async () => {
    const root = await createRoot()
    const first = join(root, "sandboxes/first")
    const second = join(root, "sandboxes/second")
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(join(first, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(second, "package.json"), JSON.stringify({ packageManager: "npm@11", private: true, type: "module" }))
    await writeFile(join(first, "run.sandbox.ts"), "export default null")
    await writeFile(join(second, "run.sandbox.ts"), "export default null")

    const firstProject = await resolveSandboxProject(join(first, "run.sandbox.ts"), root)
    const secondProject = await resolveSandboxProject(join(second, "run.sandbox.ts"), root)

    expect(firstProject.install.command).toBe("npm")
    expect(secondProject.install.command).toBe("npm")
    expect(firstProject.digest).not.toBe(secondProject.digest)
  })

  it("delegates pnpm installation to the standard workspace root", async () => {
    const root = await createRoot()
    const packageRoot = join(root, "sandboxes/image")
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10", private: true }))
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - sandboxes/*\n")
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
    await writeFile(join(root, "sandboxes/pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters: {}\n")
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(packageRoot, "optimize.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(packageRoot, "optimize.sandbox.ts"), root)

    expect(project.install).toEqual({
      args: ["install", "--frozen-lockfile"],
      command: "pnpm",
      cwd: ".",
    })
    expect(project.packagePath).toBe("sandboxes/image")
    expect(project.files).toHaveProperty("pnpm-workspace.yaml")
    expect(project.files).toHaveProperty("pnpm-lock.yaml")
    expect(project.files).not.toHaveProperty("sandboxes/pnpm-lock.yaml")
    expect(project.files).toHaveProperty("sandboxes/image/package.json")
  })

  it("includes the transitive local pnpm workspace dependency closure", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const first = join(root, "packages/first")
    const second = join(root, "packages/second")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(first, { recursive: true }), mkdir(second, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({ dependencies: { "@fixture/first": "workspace:*" }, private: true }))
    await writeFile(join(first, "package.json"), JSON.stringify({ dependencies: { "@fixture/second": "workspace:^" }, name: "@fixture/first", type: "module" }))
    await writeFile(join(first, "index.js"), "export { value } from '@fixture/second'\n")
    await writeFile(join(second, "package.json"), JSON.stringify({ exports: "./index.js", name: "@fixture/second", type: "module" }))
    await writeFile(join(second, "index.js"), "export const value = 42\n")
    await writeFile(join(sandbox, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(sandbox, "run.sandbox.ts"), root)

    expect(project.install.command).toBe("pnpm")
    expect(project.files).toHaveProperty("packages/first/index.js")
    expect(project.files).toHaveProperty("packages/second/index.js")
  })

  it("executes TypeScript package projects without runtime type stripping", { timeout: 30_000 }, async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const first = join(root, "packages/first")
    const second = join(root, "packages/second")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(first, { recursive: true }), mkdir(second, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - sandboxes/*\n  - packages/*\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({ dependencies: { "@fixture/first": "workspace:*" }, private: true, type: "module" }))
    await mkdir(join(sandbox, "lib"))
    await writeFile(join(sandbox, "lib/prompt.md"), "relative helper asset")
    await writeFile(join(sandbox, "lib/helper.mts"), [
      "import { readFile } from 'node:fs/promises'",
      "export const asset = await readFile(new URL('./prompt.md', import.meta.url), 'utf8')",
      "",
    ].join("\n"))
    await writeFile(join(sandbox, "lib/helper.d.ts"), "export { Missing } from './missing'\n")
    await writeFile(join(first, "package.json"), JSON.stringify({ dependencies: { "@fixture/second": "workspace:*" }, exports: "./index.js", name: "@fixture/first", type: "module" }))
    await writeFile(join(first, "index.js"), "export { value } from '@fixture/second'\n")
    await writeFile(join(second, "package.json"), JSON.stringify({ exports: "./index.js", name: "@fixture/second", type: "module" }))
    await writeFile(join(second, "index.js"), "export const value = 42\n")
    const definitionFile = join(sandbox, "index.ts")
    await writeFile(definitionFile, [
      "import { value } from '@fixture/first'",
      "import { asset } from './lib/helper.mts'",
      "interface SandboxPayload { nested: boolean }",
      "export default async function run(payload: SandboxPayload, context: unknown) {",
      "  await Promise.resolve()",
      "  return { asset, context, payload, value }",
      "}",
      "",
    ].join("\n"))
    const project = await resolveSandboxProject(definitionFile, root)
    expect(project.files).toHaveProperty("sandboxes/image/lib/prompt.md")
    const bundle = await bundleSandboxDefinition(await readFile(definitionFile, "utf8"), definitionFile, {
      execution: "module",
      project,
    })
    expect(bundle.entry).toBe("sandboxes/image/index.ts.mjs")
    expect(bundle.project?.files).toHaveProperty("sandboxes/image/lib/helper.mts.mjs")
    const box = await resolveBox({ runtime: "trusted-host" }, {}, { requires: ["node", "pnpm"] })
    const session = await box.open()
    try {
      const execution = createSandboxExecutionBox(session, "cloudflare")
      const root = dirname(session.cwd)
      const physical = (path: string) => path.startsWith('/') ? join(root, path) : path
      const exec = execution.exec
      const writeFile = execution.writeFile
      execution.exec = async (command, args = [], options) => {
        const physicalArgs = args.map(physical)
        const runtimeArgs = command === "node" && args[0] === "-e" && args[1] === "import(process.argv[1])"
          ? ["--no-experimental-strip-types", ...physicalArgs]
          : physicalArgs
        return await exec(command, runtimeArgs, {
          ...options,
          cwd: options?.cwd && physical(options.cwd),
        })
      }
      execution.writeFile = async (path, contents) => await writeFile(path, contents.replaceAll('/tmp/vitehub-sandbox', `${root}/tmp/vitehub-sandbox`))
      await expect(executeSandboxDefinition(
        execution,
        "workspace-dependency",
        undefined,
        bundle,
        { requested: true },
        { requestId: "test" },
      )).resolves.toEqual({
        asset: "relative helper asset",
        context: { requestId: "test" },
        payload: { requested: true },
        value: 42,
      })
    }
    finally {
      await session.close()
    }
  })

  it("does not inherit an unrelated ancestor lockfile", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/independent")
    await mkdir(sandbox, { recursive: true })
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, name: "root" }))
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(sandbox, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(sandbox, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(sandbox, "run.sandbox.ts"), root)

    expect(project.install).toEqual({ args: ["install"], command: "npm", cwd: "." })
    expect(project.packagePath).toBe(".")
    expect(project.files).not.toHaveProperty("package-lock.json")
  })

  it("ignores legacy binary bun.lockb files", async () => {
    const root = await createRoot()
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(root, "bun.lockb"), new Uint8Array([0, 255, 1]))
    await writeFile(join(root, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(root, "run.sandbox.ts"), root)

    expect(project.install.command).toBe("npm")
    expect(project.files).not.toHaveProperty("bun.lockb")
  })

  it("does not upload local environment and npm credential files", async () => {
    const root = await createRoot()
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(root, ".env"), "TOKEN=secret\n")
    await writeFile(join(root, ".env.local"), "TOKEN=local-secret\n")
    await writeFile(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n")
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src/.env.production"), "TOKEN=nested-secret\n")
    await writeFile(join(root, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(root, "run.sandbox.ts"), root)

    expect(project.files).not.toHaveProperty(".env")
    expect(project.files).not.toHaveProperty(".env.local")
    expect(project.files).not.toHaveProperty(".npmrc")
    expect(project.files).not.toHaveProperty("src/.env.production")
  })

  it("preserves executable project file modes", async () => {
    const root = await createRoot()
    await mkdir(join(root, "scripts"))
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(root, "scripts/build.sh"), "#!/bin/sh\n")
    await chmod(join(root, "scripts/build.sh"), 0o755)
    await writeFile(join(root, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(root, "run.sandbox.ts"), root)

    expect(project.files["scripts/build.sh"]?.mode).toBe(0o755)
    expect(project.files["package.json"]?.mode).toBeUndefined()
  })

  it("uses the Yarn Classic frozen lockfile flag", async () => {
    const root = await createRoot()
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@1.22.22", private: true }))
    await writeFile(join(root, "yarn.lock"), "# yarn lockfile v1\n")
    await writeFile(join(root, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(root, "run.sandbox.ts"), root)

    expect(project.install).toEqual({ args: ["install", "--frozen-lockfile"], command: "yarn", cwd: "." })
  })

  it("recognizes Yarn Classic from a lockfile without a packageManager field", async () => {
    const root = await createRoot()
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(root, "yarn.lock"), "# yarn lockfile v1\n")
    await writeFile(join(root, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(root, "run.sandbox.ts"), root)

    expect(project.install).toEqual({ args: ["install", "--frozen-lockfile"], command: "yarn", cwd: "." })
  })

  it("does not escape the Sandbox scan root for a manifest", async () => {
    const parent = await createRoot()
    const root = join(parent, "app")
    const sandbox = join(root, "sandboxes/task")
    await mkdir(sandbox, { recursive: true })
    await writeFile(join(parent, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(sandbox, "run.sandbox.ts"), "export default null")

    await expect(resolveSandboxProject(join(sandbox, "run.sandbox.ts"), root))
      .rejects.toThrow("requires a package.json")
  })

  it("rejects project files that escape the scan root through symlinks", async () => {
    const parent = await createRoot()
    const root = join(parent, "app")
    const sandbox = join(root, "sandboxes/task")
    const externalManifest = join(parent, "package.json")
    await mkdir(sandbox, { recursive: true })
    await writeFile(externalManifest, JSON.stringify({ private: true }))
    await symlink(externalManifest, join(sandbox, "package.json"))
    await writeFile(join(sandbox, "run.sandbox.ts"), "export default null")

    await expect(resolveSandboxProject(join(sandbox, "run.sandbox.ts"), root))
      .rejects.toThrow("escapes its scan root")
  })
})
