import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"

import { transform } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"

import type { Plugin } from "esbuild"

const tempDirs: string[] = []

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-internal-esbuild-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("bundleEsmEntry", () => {
  it("applies Vite replacement-string tokens in prefix aliases", async () => {
    const rootDir = await createTempDir()
    const replacementDir = resolve(rootDir, "replacement")
    const replacement = resolve(replacementDir, "@/job.mjs")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await mkdir(dirname(replacement), { recursive: true })
    await Promise.all([
      writeFile(entry, 'export { value } from "@/job.mjs"\n', "utf8"),
      writeFile(replacement, "export const value = 'replacement-token'\n", "utf8"),
    ])

    const { bundleEsmEntry, encodeProviderOutputAliases } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: encodeProviderOutputAliases([{ find: "@", replacement: `${replacementDir}/$&` }]),
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("replacement-token")
  })

  it("leaves unresolved optional package imports to the caller", async () => {
    const rootDir = await createTempDir()
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await writeFile(entry, 'import "optional-package"\n', "utf8")

    const { bundleEsmEntry, encodeProviderOutputAliases } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: encodeProviderOutputAliases([{ find: "example", replacement: resolve(rootDir, "replacement") }]),
      external: ["optional-package"],
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain('import "optional-package"')
  })

  it("applies exact alias replacement tokens to the public specifier after resolution", async () => {
    const rootDir = await createTempDir()
    const packageDir = resolve(rootDir, "node_modules/example")
    const original = resolve(packageDir, "index.mjs")
    const replacement = resolve(rootDir, "replacement/example")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([mkdir(packageDir, { recursive: true }), mkdir(dirname(replacement), { recursive: true })])
    await Promise.all([
      writeFile(resolve(packageDir, "package.json"), `${JSON.stringify({ exports: "./index.mjs", name: "example", type: "module" })}\n`, "utf8"),
      writeFile(original, "export const value = 'original'\n", "utf8"),
      writeFile(replacement, "export const value = 'replacement-token'\n", "utf8"),
      writeFile(entry, `export { value } from ${JSON.stringify(original)}\n`, "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { example: `${resolve(rootDir, "replacement")}/$&` },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("replacement-token")
  })

  it("preserves overlapping trailing-slash alias prefixes", async () => {
    const rootDir = await createTempDir()
    const broadDir = resolve(rootDir, "broad")
    const nestedDir = resolve(rootDir, "nested")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(broadDir),
      mkdir(nestedDir),
    ])
    await Promise.all([
      writeFile(entry, 'export { value } from "@//job.mjs"\n', "utf8"),
      writeFile(resolve(broadDir, "job.mjs"), "export const value = 'broad'\n", "utf8"),
      writeFile(resolve(nestedDir, "job.mjs"), "export const value = 'nested'\n", "utf8"),
    ])

    const { bundleEsmEntry, encodeProviderOutputAliases } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: encodeProviderOutputAliases([
        { find: "@/", replacement: broadDir },
        { find: "@//", replacement: nestedDir },
      ]),
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("broad")
    expect(await readFile(outfile, "utf8")).not.toContain("nested")
  })

  it("preserves special property names as exact aliases", async () => {
    const rootDir = await createTempDir()
    const replacement = resolve(rootDir, "replacement.mjs")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      writeFile(entry, 'export { value } from "__proto__"\n', "utf8"),
      writeFile(replacement, "export const value = 'replacement'\n", "utf8"),
    ])

    const { bundleEsmEntry, encodeProviderOutputAliases } = await import("../src/build/esbuild.ts")
    const alias = encodeProviderOutputAliases([{ find: "__proto__", replacement }])
    expect(Object.hasOwn(alias, "__proto__")).toBe(true)
    await bundleEsmEntry(entry, outfile, { alias, format: "esm", platform: "node" })

    expect(await readFile(outfile, "utf8")).toContain("replacement")
  })

  it("redirects imports that were resolved before bundling", async () => {
    const rootDir = await createTempDir()
    const entry = resolve(rootDir, "entry.mjs")
    const original = resolve(rootDir, "original.mjs")
    const replacement = resolve(rootDir, "replacement.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      writeFile(entry, `export { value } from ${JSON.stringify(original)}\n`, "utf8"),
      writeFile(original, "export const value = 'original'\n", "utf8"),
      writeFile(replacement, "export const value = 'replacement'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { [original]: replacement },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("replacement")
    expect(await readFile(outfile, "utf8")).not.toContain("original")
  })

  it("preserves bare imports that resolve to an absolute alias key", async () => {
    const rootDir = await createTempDir()
    const packageDir = resolve(rootDir, "node_modules/example")
    const original = resolve(packageDir, "index.mjs")
    const replacement = resolve(rootDir, "replacement.mjs")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await mkdir(packageDir, { recursive: true })
    await Promise.all([
      writeFile(resolve(packageDir, "package.json"), `${JSON.stringify({ exports: "./index.mjs", name: "example", type: "module" })}\n`, "utf8"),
      writeFile(original, "export const value = 'package'\n", "utf8"),
      writeFile(replacement, "export const value = 'replacement'\n", "utf8"),
      writeFile(entry, 'export { value } from "example"\n', "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { [original]: replacement },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("package")
    expect(await readFile(outfile, "utf8")).not.toContain("replacement")
  })

  it("redirects relative imports that match absolute aliases", async () => {
    const rootDir = await createTempDir()
    const sourceDir = resolve(rootDir, "retained")
    const entry = resolve(sourceDir, "entry.mjs")
    const original = resolve(rootDir, "original.mjs")
    const replacement = resolve(rootDir, "replacement.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await mkdir(sourceDir, { recursive: true })
    await Promise.all([
      writeFile(entry, 'export { value } from "../original.mjs"\n', "utf8"),
      writeFile(original, "export const value = 'original'\n", "utf8"),
      writeFile(replacement, "export const value = 'replacement'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { [original]: replacement },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("replacement")
    expect(await readFile(outfile, "utf8")).not.toContain("original")
  })

  it("redirects relative imports through canonical absolute aliases", async () => {
    const rootDir = await createTempDir()
    const physicalDir = resolve(rootDir, "packages/kv/dist")
    const retainedDir = resolve(rootDir, "retained")
    const linkedPackagesDir = resolve(retainedDir, "packages")
    const entry = resolve(retainedDir, "entry.mjs")
    const original = resolve(physicalDir, "vite.mjs")
    const replacement = resolve(rootDir, "guard.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(physicalDir, { recursive: true }),
      mkdir(retainedDir, { recursive: true }),
    ])
    await Promise.all([
      symlink(resolve(rootDir, "packages"), linkedPackagesDir, "dir"),
      writeFile(original, "export const value = 'config-only'\n", "utf8"),
      writeFile(replacement, "export const value = 'runtime-guard'\n", "utf8"),
      writeFile(entry, 'export { value } from "./packages/kv/dist/vite.mjs"\n', "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { [original]: replacement },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("runtime-guard")
    expect(await readFile(outfile, "utf8")).not.toContain("config-only")
  })

  it("canonicalizes absolute alias keys before matching copied dependencies", async () => {
    const rootDir = await createTempDir()
    const physicalDir = resolve(rootDir, "packages/kv/dist")
    const linkedDir = resolve(rootDir, "node_modules/@vite-hub/kv")
    const entry = resolve(rootDir, "entry.mjs")
    const original = resolve(physicalDir, "vite.mjs")
    const linkedOriginal = resolve(linkedDir, "dist/vite.mjs")
    const replacement = resolve(rootDir, "guard.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(physicalDir, { recursive: true }),
      mkdir(dirname(linkedDir), { recursive: true }),
    ])
    await Promise.all([
      symlink(resolve(rootDir, "packages/kv"), linkedDir, "dir"),
      writeFile(original, "export const value = 'config-only'\n", "utf8"),
      writeFile(replacement, "export const value = 'runtime-guard'\n", "utf8"),
      writeFile(entry, `export { value } from ${JSON.stringify(original)}\n`, "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { [linkedOriginal]: replacement },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("runtime-guard")
    expect(await readFile(outfile, "utf8")).not.toContain("config-only")
  })

  it("matches bare package aliases after relative imports become absolute", async () => {
    const rootDir = await createTempDir()
    const packageDir = resolve(rootDir, "node_modules/@vite-hub/kv")
    const original = resolve(packageDir, "dist/vite.mjs")
    const replacement = resolve(rootDir, "guard.mjs")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await mkdir(dirname(original), { recursive: true })
    await Promise.all([
      writeFile(resolve(packageDir, "package.json"), `${JSON.stringify({ exports: { "./vite": "./dist/vite.mjs" }, name: "@vite-hub/kv", type: "module" })}\n`, "utf8"),
      writeFile(original, 'import "node:os"\nexport const value = "config-only"\n', "utf8"),
      writeFile(replacement, 'export const value = "runtime-guard"\n', "utf8"),
      writeFile(entry, `export { value } from ${JSON.stringify(original)}\n`, "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { "@vite-hub/kv/vite": replacement },
      format: "esm",
      platform: "neutral",
    })

    expect(await readFile(outfile, "utf8")).toContain("runtime-guard")
    expect(await readFile(outfile, "utf8")).not.toContain("config-only")
  })

  it("matches scope aliases after scoped package imports become absolute", async () => {
    const rootDir = await createTempDir()
    const packageDir = resolve(rootDir, "node_modules/@scope/example")
    const original = resolve(packageDir, "dist/vite.mjs")
    const replacementDir = resolve(rootDir, "replacement")
    const replacement = resolve(replacementDir, "example/vite")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([mkdir(dirname(original), { recursive: true }), mkdir(dirname(replacement), { recursive: true })])
    await Promise.all([
      writeFile(resolve(packageDir, "package.json"), `${JSON.stringify({ exports: { "./vite": "./dist/vite.mjs" }, name: "@scope/example", type: "module" })}\n`, "utf8"),
      writeFile(original, "export const value = 'original'\n", "utf8"),
      writeFile(replacement, "export const value = 'replacement'\n", "utf8"),
      writeFile(entry, `export { value } from ${JSON.stringify(original)}\n`, "utf8"),
    ])

    const { bundleEsmEntry, encodeProviderOutputAliases } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: encodeProviderOutputAliases([{ find: "@scope", replacement: replacementDir }]),
      format: "esm",
      platform: "node",
    })

    const output = await readFile(outfile, "utf8")
    expect(output).toContain("replacement")
    expect(output).not.toContain("original")
  })

  it.each([
    { exportTarget: "./jobs/*", replacementPath: "jobs/task.mjs", sourcePath: "jobs/task.mjs" },
    { exportTarget: "./src/jobs/*", replacementPath: "jobs/task.mjs", sourcePath: "src/jobs/task.mjs" },
    { exportTarget: "./src/*/generated/*.mjs", replacementPath: "jobs/task", sourcePath: "src/task/generated/task.mjs" },
  ])("matches bare package prefix aliases after $exportTarget imports become absolute", async ({ exportTarget, replacementPath, sourcePath }) => {
    const rootDir = await createTempDir()
    const packageDir = resolve(rootDir, "node_modules/example")
    const original = resolve(packageDir, sourcePath)
    const replacementDir = resolve(rootDir, "replacement")
    const replacement = resolve(replacementDir, replacementPath)
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(dirname(original), { recursive: true }),
      mkdir(dirname(replacement), { recursive: true }),
    ])
    await Promise.all([
      writeFile(resolve(packageDir, "package.json"), `${JSON.stringify({ exports: { "./jobs/*": exportTarget }, name: "example", type: "module" })}\n`, "utf8"),
      writeFile(original, "export const value = 'original'\n", "utf8"),
      writeFile(replacement, "export const value = 'replacement'\n", "utf8"),
      writeFile(entry, `export { value } from ${JSON.stringify(original)}\n`, "utf8"),
    ])

    const { bundleEsmEntry, encodeProviderOutputAliases } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: encodeProviderOutputAliases([{ find: "example", replacement: replacementDir }]),
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("replacement")
    expect(await readFile(outfile, "utf8")).not.toContain("original")
  })

  it("does not guess a legacy public suffix after imports become absolute", async () => {
    const rootDir = await createTempDir()
    const packageDir = resolve(rootDir, "node_modules/example")
    const original = resolve(packageDir, "jobs/task.mjs")
    const replacementDir = resolve(rootDir, "replacement")
    const replacement = resolve(replacementDir, "jobs/task")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(dirname(original), { recursive: true }),
      mkdir(dirname(replacement), { recursive: true }),
    ])
    await Promise.all([
      writeFile(resolve(packageDir, "package.json"), `${JSON.stringify({ name: "example", type: "module" })}\n`, "utf8"),
      writeFile(original, "export const value = 'original'\n", "utf8"),
      writeFile(replacement, "export const value = 'replacement'\n", "utf8"),
      writeFile(entry, `export { value } from ${JSON.stringify(original)}\n`, "utf8"),
    ])

    const { bundleEsmEntry, encodeProviderOutputAliases } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: encodeProviderOutputAliases([{ find: "example", replacement: replacementDir }]),
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("original")
    expect(await readFile(outfile, "utf8")).not.toContain("replacement")
  })

  it("preserves explicit legacy package suffixes before resolution", async () => {
    const rootDir = await createTempDir()
    const packageDir = resolve(rootDir, "node_modules/example")
    const original = resolve(packageDir, "jobs/task.mjs")
    const replacementDir = resolve(rootDir, "replacement")
    const extensionlessReplacement = resolve(replacementDir, "jobs/task")
    const replacement = resolve(replacementDir, "jobs/task.mjs")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([mkdir(dirname(original), { recursive: true }), mkdir(dirname(replacement), { recursive: true })])
    await Promise.all([
      writeFile(resolve(packageDir, "package.json"), `${JSON.stringify({ name: "example", type: "module" })}\n`, "utf8"),
      writeFile(original, "export const value = 'original'\n", "utf8"),
      writeFile(extensionlessReplacement, "export const value = 'extensionless-replacement'\n", "utf8"),
      writeFile(replacement, "export const value = 'explicit-replacement'\n", "utf8"),
      writeFile(entry, 'export { value } from "example/jobs/task.mjs"\n', "utf8"),
    ])

    const { bundleEsmEntry, encodeProviderOutputAliases } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: encodeProviderOutputAliases([{ find: "example", replacement: replacementDir }]),
      format: "esm",
      platform: "node",
    })

    const output = await readFile(outfile, "utf8")
    expect(output).toContain("explicit-replacement")
    expect(output).not.toContain("extensionless-replacement")
  })

  it("does not reverse aliases through duplicate package exports", async () => {
    const rootDir = await createTempDir()
    const packageDir = resolve(rootDir, "node_modules/example")
    const original = resolve(packageDir, "shared.mjs")
    const replacementDir = resolve(rootDir, "replacement")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([mkdir(packageDir, { recursive: true }), mkdir(replacementDir)])
    await Promise.all([
      writeFile(resolve(packageDir, "package.json"), `${JSON.stringify({ exports: { "./foo": "./shared.mjs", "./bar": "./shared.mjs" }, name: "example", type: "module" })}\n`, "utf8"),
      writeFile(original, "export const value = 'original'\n", "utf8"),
      writeFile(resolve(replacementDir, "foo"), "export const value = 'replacement'\n", "utf8"),
      writeFile(entry, `export { value } from ${JSON.stringify(original)}\n`, "utf8"),
    ])

    const { bundleEsmEntry, encodeProviderOutputAliases } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: encodeProviderOutputAliases([{ find: "example/foo", replacement: resolve(replacementDir, "foo") }]),
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("original")
    expect(await readFile(outfile, "utf8")).not.toContain("replacement")
  })

  it("does not match exact aliases against sibling export prefixes", async () => {
    const rootDir = await createTempDir()
    const packageDir = resolve(rootDir, "node_modules/example")
    const original = resolve(packageDir, "jobs/task.mjs")
    const replacement = resolve(rootDir, "replacement.mjs")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await mkdir(dirname(original), { recursive: true })
    await Promise.all([
      writeFile(resolve(packageDir, "package.json"), `${JSON.stringify({ exports: { "./jobs/task": "./jobs/task.mjs" }, name: "example", type: "module" })}\n`, "utf8"),
      writeFile(original, "export const value = 'original'\n", "utf8"),
      writeFile(replacement, "export const value = 'replacement'\n", "utf8"),
      writeFile(entry, `export { value } from ${JSON.stringify(original)}\n`, "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { "example/job": replacement },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("original")
    expect(await readFile(outfile, "utf8")).not.toContain("replacement")
  })

  it("resolves bare aliases independently for each importer", async () => {
    const rootDir = await createTempDir()
    const rootPackageDir = resolve(rootDir, "node_modules/example")
    const nestedDir = resolve(rootDir, "nested")
    const nestedPackageDir = resolve(nestedDir, "node_modules/example")
    const candidate = resolve(nestedPackageDir, "index.json")
    const replacement = resolve(rootDir, "replacement.json")
    const entry = resolve(rootDir, "entry.mjs")
    const rootImporter = resolve(rootDir, "root-importer.mjs")
    const nestedImporter = resolve(nestedDir, "nested-importer.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(rootPackageDir, { recursive: true }),
      mkdir(nestedPackageDir, { recursive: true }),
    ])
    await Promise.all([
      writeFile(resolve(rootPackageDir, "package.json"), `${JSON.stringify({ main: "index.json", name: "example" })}\n`, "utf8"),
      writeFile(resolve(rootPackageDir, "index.json"), `${JSON.stringify({ value: "root-package" })}\n`, "utf8"),
      writeFile(resolve(nestedPackageDir, "package.json"), `${JSON.stringify({ main: "index.json", name: "example" })}\n`, "utf8"),
      writeFile(candidate, `${JSON.stringify({ value: "nested-package" })}\n`, "utf8"),
      writeFile(replacement, `${JSON.stringify({ value: "replacement" })}\n`, "utf8"),
      writeFile(rootImporter, `export { default as rootValue } from ${JSON.stringify(candidate)}\n`, "utf8"),
      writeFile(nestedImporter, `export { default as nestedValue } from ${JSON.stringify(candidate)} with { type: "json" }\n`, "utf8"),
      writeFile(entry, 'export { rootValue } from "./root-importer.mjs"\nexport { nestedValue } from "./nested/nested-importer.mjs"\n', "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { example: replacement },
      format: "esm",
      platform: "node",
      workingDir: rootDir,
    })

    const output = await readFile(outfile, "utf8")
    expect(output).toContain("nested-package")
    expect(output).toContain("replacement")
  })

  it("resolves bare aliases independently for each plugin context", async () => {
    const rootDir = await createTempDir()
    const packageDir = resolve(rootDir, "node_modules/example")
    const candidate = resolve(packageDir, "index.mjs")
    const otherCandidate = resolve(rootDir, "other-example.mjs")
    const replacement = resolve(rootDir, "replacement.mjs")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await mkdir(packageDir, { recursive: true })
    await Promise.all([
      writeFile(resolve(packageDir, "package.json"), `${JSON.stringify({ main: "index.mjs", name: "example" })}\n`, "utf8"),
      writeFile(candidate, "export const value = 'original'\n", "utf8"),
      writeFile(otherCandidate, "export const value = 'other'\n", "utf8"),
      writeFile(replacement, "export const value = 'replacement'\n", "utf8"),
      writeFile(entry, 'export { value as first } from "context:first"\nexport { value as second } from "context:second"\n', "utf8"),
    ])

    const plugin: Plugin = {
      name: "plugin-context-alias",
      setup(build) {
        build.onResolve({ filter: /^context:/ }, args => ({
          namespace: "plugin-context",
          path: args.path,
          pluginData: { context: args.path },
        }))
        build.onLoad({ filter: /.*/, namespace: "plugin-context" }, args => ({
          contents: `export { value } from ${JSON.stringify(candidate)}`,
          loader: "js",
          pluginData: args.pluginData,
          resolveDir: rootDir,
        }))
        build.onResolve({ filter: /^example$/ }, args => ({
          namespace: "file",
          path: args.pluginData?.context === "context:first" ? candidate : otherCandidate,
        }))
      },
    }

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { example: replacement },
      format: "esm",
      platform: "node",
      plugins: [plugin],
      workingDir: rootDir,
    })

    const output = await readFile(outfile, "utf8")
    expect(output).toContain("replacement")
    expect(output).toContain("original")
  })

  it("slices resolved relative prefix aliases from their absolute base", async () => {
    const rootDir = await createTempDir()
    const sourceDir = resolve(rootDir, "src")
    const replacementDir = resolve(rootDir, "replacement")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(resolve(sourceDir, "jobs"), { recursive: true }),
      mkdir(resolve(replacementDir, "jobs"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(entry, `export { value } from ${JSON.stringify(resolve(sourceDir, "jobs/task.mjs"))}\n`, "utf8"),
      writeFile(resolve(sourceDir, "jobs/task.mjs"), "export const value = 'original'\n", "utf8"),
      writeFile(resolve(replacementDir, "jobs/task.mjs"), "export const value = 'replacement'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { "./src/\0vitehub-prefix:0": `${replacementDir}/` },
      format: "esm",
      platform: "node",
      workingDir: rootDir,
    })

    expect(await readFile(outfile, "utf8")).toContain("replacement")
    expect(await readFile(outfile, "utf8")).not.toContain("original")
  })

  it("joins prefix alias replacements that omit a trailing slash", async () => {
    const rootDir = await createTempDir()
    const sourceDir = resolve(rootDir, "source")
    const replacementDir = resolve(rootDir, "replacement")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(sourceDir),
      mkdir(replacementDir),
    ])
    await Promise.all([
      writeFile(entry, `export { value } from ${JSON.stringify(resolve(sourceDir, "job.mjs"))}\n`, "utf8"),
      writeFile(resolve(sourceDir, "job.mjs"), "export const value = 'original'\n", "utf8"),
      writeFile(resolve(replacementDir, "job.mjs"), "export const value = 'replacement'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { [`${sourceDir}/\0vitehub-prefix:0`]: replacementDir },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("replacement")
  })

  it("resolves relative prefix aliases from a stable base for nested importers", async () => {
    const rootDir = await createTempDir()
    const sourceDir = resolve(rootDir, "src")
    const replacementDir = resolve(rootDir, "replacement")
    const nestedDir = resolve(rootDir, "nested")
    const entry = resolve(rootDir, "entry.mjs")
    const importer = resolve(nestedDir, "importer.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(resolve(sourceDir, "jobs"), { recursive: true }),
      mkdir(resolve(replacementDir, "jobs"), { recursive: true }),
      mkdir(nestedDir, { recursive: true }),
    ])
    await Promise.all([
      writeFile(entry, 'export { value } from "./nested/importer.mjs"\n', "utf8"),
      writeFile(importer, `export { value } from ${JSON.stringify(resolve(sourceDir, "jobs/task.mjs"))}\n`, "utf8"),
      writeFile(resolve(sourceDir, "jobs/task.mjs"), "export const value = 'original'\n", "utf8"),
      writeFile(resolve(replacementDir, "jobs/task.mjs"), "export const value = 'replacement'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { "./src/\0vitehub-prefix:0": `${replacementDir}/` },
      format: "esm",
      platform: "node",
      workingDir: rootDir,
    })

    expect(await readFile(outfile, "utf8")).toContain("replacement")
    expect(await readFile(outfile, "utf8")).not.toContain("original")
  })

  it("matches relative prefix aliases before resolving nested imports", async () => {
    const rootDir = await createTempDir()
    const nestedDir = resolve(rootDir, "nested")
    const replacementDir = resolve(rootDir, "replacement")
    const entry = resolve(rootDir, "entry.mjs")
    const importer = resolve(nestedDir, "importer.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(resolve(nestedDir, "src/jobs"), { recursive: true }),
      mkdir(resolve(replacementDir, "jobs"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(entry, 'export { value } from "./nested/importer.mjs"\n', "utf8"),
      writeFile(importer, 'export { value } from "./src/jobs/task.mjs"\n', "utf8"),
      writeFile(resolve(nestedDir, "src/jobs/task.mjs"), "export const value = 'original'\n", "utf8"),
      writeFile(resolve(replacementDir, "jobs/task.mjs"), "export const value = 'replacement'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { "./src/\0vitehub-prefix:0": `${replacementDir}/` },
      format: "esm",
      platform: "node",
      workingDir: rootDir,
    })

    expect(await readFile(outfile, "utf8")).toContain("replacement")
    expect(await readFile(outfile, "utf8")).not.toContain("original")
  })

  it("does not match normalized relative imports against relative prefix aliases", async () => {
    const rootDir = await createTempDir()
    const sourceDir = resolve(rootDir, "src")
    const otherDir = resolve(rootDir, "other")
    const replacementDir = resolve(rootDir, "replacement")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(sourceDir, { recursive: true }),
      mkdir(otherDir, { recursive: true }),
      mkdir(replacementDir, { recursive: true }),
    ])
    await Promise.all([
      writeFile(entry, 'export { value } from "./other/../src/job.mjs"\n', "utf8"),
      writeFile(resolve(sourceDir, "job.mjs"), "export const value = 'original'\n", "utf8"),
      writeFile(resolve(replacementDir, "job.mjs"), "export const value = 'replacement'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { "./src/\0vitehub-prefix:0": `${replacementDir}/` },
      format: "esm",
      platform: "node",
      workingDir: rootDir,
    })

    expect(await readFile(outfile, "utf8")).toContain("original")
    expect(await readFile(outfile, "utf8")).not.toContain("replacement")
  })

  it("resolves relative alias replacements from a stable base for nested importers", async () => {
    const rootDir = await createTempDir()
    const nestedDir = resolve(rootDir, "nested")
    const entry = resolve(rootDir, "entry.mjs")
    const importer = resolve(nestedDir, "importer.mjs")
    const replacement = resolve(rootDir, "replacement.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await mkdir(nestedDir, { recursive: true })
    await Promise.all([
      writeFile(entry, 'export { value } from "./nested/importer.mjs"\n', "utf8"),
      writeFile(importer, 'export { value } from "alias-source"\n', "utf8"),
      writeFile(replacement, "export const value = 'replacement'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { "alias-source": "./replacement.mjs" },
      format: "esm",
      platform: "node",
      workingDir: rootDir,
    })

    expect(await readFile(outfile, "utf8")).toContain("replacement")
  })

  it("keeps explicit trailing-slash aliases exact", async () => {
    const rootDir = await createTempDir()
    const replacement = resolve(rootDir, "replacement.mjs")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      writeFile(replacement, "export const value = 'exact'\n", "utf8"),
      writeFile(entry, 'export { value } from "@/"\n', "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { "@/": replacement, "@//": `${dirname(replacement)}/` },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("exact")

    await writeFile(entry, 'export { value } from "@/jobs"\n', "utf8")
    await expect(bundleEsmEntry(entry, outfile, {
      alias: { "@/": replacement, "@//": `${dirname(replacement)}/` },
      format: "esm",
      platform: "node",
    })).rejects.toThrow('Could not resolve "@/jobs"')
  })

  it("preserves declaration order for overlapping prefix aliases", async () => {
    const rootDir = await createTempDir()
    const broadDir = resolve(rootDir, "broad")
    const specificDir = resolve(rootDir, "specific")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      mkdir(resolve(broadDir, "jobs"), { recursive: true }),
      mkdir(specificDir, { recursive: true }),
    ])
    await Promise.all([
      writeFile(entry, 'export { value } from "@/jobs/task.mjs"\n', "utf8"),
      writeFile(resolve(broadDir, "jobs/task.mjs"), "export const value = 'broad'\n", "utf8"),
      writeFile(resolve(specificDir, "task.mjs"), "export const value = 'specific'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: {
        "@/": `${broadDir}/`,
        "@/jobs/": `${specificDir}/`,
      },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("broad")
    expect(await readFile(outfile, "utf8")).not.toContain("specific")
  })

  it("preserves declaration order across prefix and exact aliases", async () => {
    const rootDir = await createTempDir()
    const broadDir = resolve(rootDir, "broad")
    const specific = resolve(rootDir, "specific.mjs")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await mkdir(broadDir)
    await Promise.all([
      writeFile(entry, 'export { value } from "@/jobs.mjs"\n', "utf8"),
      writeFile(resolve(broadDir, "jobs.mjs"), "export const value = 'broad'\n", "utf8"),
      writeFile(specific, "export const value = 'specific'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: {
        "@/": `${broadDir}/`,
        "@/jobs.mjs": specific,
      },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("broad")
    expect(await readFile(outfile, "utf8")).not.toContain("specific")
  })

  it("preserves first-match semantics for duplicate exact aliases", async () => {
    const rootDir = await createTempDir()
    const first = resolve(rootDir, "first.mjs")
    const second = resolve(rootDir, "second.mjs")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await Promise.all([
      writeFile(entry, 'export { value } from "duplicate"\n', "utf8"),
      writeFile(first, "export const value = 'first'\n", "utf8"),
      writeFile(second, "export const value = 'second'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: {
        duplicate: first,
        "duplicate\0vitehub-exact:1": second,
      },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("first")
    expect(await readFile(outfile, "utf8")).not.toContain("second")
  })

  it("preserves broad aliases when an explicit slash alias follows", async () => {
    const rootDir = await createTempDir()
    const broadDir = resolve(rootDir, "broad")
    const explicit = resolve(rootDir, "explicit.mjs")
    const entry = resolve(rootDir, "entry.mjs")
    const outfile = resolve(rootDir, "output.mjs")
    await mkdir(broadDir)
    await Promise.all([
      writeFile(entry, 'export { value } from "@/jobs.mjs"\n', "utf8"),
      writeFile(resolve(broadDir, "jobs.mjs"), "export const value = 'broad'\n", "utf8"),
      writeFile(explicit, "export const value = 'explicit'\n", "utf8"),
    ])

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: {
        "@": broadDir,
        "@/\0vitehub-prefix:0": `${broadDir}/`,
        "@/": explicit,
      },
      format: "esm",
      platform: "node",
    })

    expect(await readFile(outfile, "utf8")).toContain("broad")
    expect(await readFile(outfile, "utf8")).not.toContain("explicit")
  })

  it("creates nested output directories for cancellable bundles", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "workers", "schedule.mjs")
    await writeFile(entry, "export default 'scheduled'\n", "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      format: "esm",
      platform: "node",
      signal: new AbortController().signal,
    })

    await expect(readFile(outfile, "utf8")).resolves.toContain("scheduled")
  })

  it("loads files as text only when imported with Vite's raw query", async () => {
    const rootDir = await createTempDir()
    const rawEntry = join(rootDir, "raw-entry.mjs")
    const plainEntry = join(rootDir, "plain-entry.mjs")
    const markdown = join(rootDir, "context.md")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(markdown, "# Repository context\n\nUse **trusted** Markdown.\n", "utf8")
    await writeFile(rawEntry, 'import context from "./context.md?raw"\nexport default context\n', "utf8")
    await writeFile(plainEntry, 'import context from "./context.md"\nexport default context\n', "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(rawEntry, outfile, { format: "esm", platform: "node" })

    // SAFETY: This bundle's entry module exports the string imported from context.md.
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: string }
    expect(loaded.default).toBe("# Repository context\n\nUse **trusted** Markdown.\n")
    await expect(bundleEsmEntry(plainEntry, outfile, { format: "esm", platform: "node" }))
      .rejects.toThrow('No loader is configured for ".md" files')
  })

  it("bundles caller-relative Markdown prompt templates without runtime source files", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "babysitter.schedule.mjs")
    const template = join(rootDir, "prompt.template.md")
    const partial = join(rootDir, "context.md")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(template, "@./context.md.\n\n[Policy](@./missing.md)\n\n`@./missing.md`\n\n`multiline\n@./missing.md\ncode`\n\n> ~~~md\n> @./missing.md\n> ~~~~\n\n    @./missing.md\n\n- Example\n\n        @./missing.md\n\n- Fenced example\n    ```md\n    @./missing.md\n    ```\n\n- Context\n    @./context.md\n\n{{{ blocker }}}\n", "utf8")
    await writeFile(partial, "Review PR {{ context.number }}.", "utf8")
    await writeFile(entry, [
      `import prompt from "./prompt.template.md"`,
      `export default () => prompt({ blocker: "> Waiting", context: { number: 42 } })`,
      ``,
    ].join("\n"), "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      format: "esm",
      platform: "node",
      rootDir,
    })
    await Promise.all([rm(template), rm(partial)])

    // SAFETY: This bundle's entry module exports an async Markdown template renderer.
    const bundled = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: () => Promise<string> }
    await expect(bundled.default()).resolves.toBe("Review PR 42..\n\n[Policy](@./missing.md)\n\n`@./missing.md`\n\n`multiline @./missing.md code`\n\n> ```md\n> @./missing.md\n> ```\n\n```\n@./missing.md\n```\n\n- Example\n  ```\n  @./missing.md\n  ```\n- Fenced example\n  ```md\n  @./missing.md\n  ```\n- Context\nReview PR 42.\n\n> Waiting")
  })

  it("fails when a bundled Markdown template import is missing", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(join(rootDir, "prompt.template.md"), "@./missing.md\n", "utf8")
    await writeFile(entry, 'import prompt from "./prompt.template.md"\nexport default prompt\n', "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await expect(bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", rootDir }))
      .rejects.toThrow("Could not resolve")
  })

  it("resolves root-absolute raw imports from the Vite root", async () => {
    const rootDir = await createTempDir()
    const sourceDir = join(rootDir, "src")
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, "context.md"), "# Root context\n", "utf8")
    await writeFile(entry, 'import context from "/src/context.md?raw"\nexport default context\n', "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", rootDir })

    // SAFETY: This bundle's entry module exports the root-relative raw file contents.
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: string }
    expect(loaded.default).toBe("# Root context\n")
  })

  it("resolves public and /@fs/ raw imports with Vite semantics", async () => {
    const rootDir = await createTempDir()
    const publicDir = join(rootDir, "public")
    const entry = join(rootDir, "entry.mjs")
    const outsideRoot = join(await createTempDir(), "outside.md")
    const outfile = join(rootDir, "bundle.mjs")
    await mkdir(publicDir, { recursive: true })
    await writeFile(join(rootDir, "robots.txt"), "root robots\n", "utf8")
    await writeFile(join(publicDir, "robots.txt"), "public robots\n", "utf8")
    await writeFile(outsideRoot, "outside context\n", "utf8")
    await writeFile(entry, [
      `import robots from "/robots.txt?raw"`,
      `import outside from ${JSON.stringify(`/@fs/${outsideRoot}?raw`)}`,
      `export default { outside, robots }`,
      ``,
    ].join("\n"), "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", rootDir })

    // SAFETY: This bundle's entry module exports the two raw file contents under these keys.
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: { outside: string, robots: string } }
    expect(loaded.default).toEqual({ outside: "outside context\n", robots: "public robots\n" })
  })

  it("lets caller plugins handle raw queries before the fallback", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(entry, 'import context from "virtual:context?raw"\nexport default context\n', "utf8")
    const callerPlugin: Plugin = {
      name: "caller-raw",
      setup(build) {
        build.onResolve({ filter: /^virtual:context\?raw$/ }, () => ({
          namespace: "caller-raw",
          path: "context",
        }))
        build.onLoad({ filter: /.*/, namespace: "caller-raw" }, () => ({
          contents: 'export default "caller handled raw"',
          loader: "js",
        }))
      },
    }

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", plugins: [callerPlugin] })

    // SAFETY: The caller plugin defines this bundle's default export as a string.
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: string }
    expect(loaded.default).toBe("caller handled raw")
  })

  it("bundles partials from direct Markdown template imports", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const template = join(rootDir, "prompt.template.md")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(entry, 'import render from "./prompt.template.md"\nexport default render\n', "utf8")
    await writeFile(template, "Hello @./partial.template.md", "utf8")
    await writeFile(join(rootDir, "partial.template.md"), "{{ name }}!", "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", rootDir })

    // SAFETY: This bundle's entry module exports a renderer for the template's named input.
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: (data: { name: string }) => Promise<string> }
    await expect(loaded.default({ name: "ViteHub" })).resolves.toBe("Hello ViteHub!")
  })

  it("preserves external results from raw fallback resolution", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    const importerData = { owner: "caller-plugin" }
    let resolverContext: { pluginData: unknown, with: Record<string, string> } | undefined
    await writeFile(entry, 'import context from "external-context?raw" with { type: "text" }\nexport default context\n', "utf8")
    const externalPlugin: Plugin = {
      name: "external-context",
      setup(build) {
        build.onLoad({ filter: /entry\.mjs$/, namespace: "file" }, async args => ({
          contents: await readFile(args.path),
          loader: "js",
          pluginData: importerData,
        }))
        build.onResolve({ filter: /^external-context$/ }, (args) => {
          resolverContext = { pluginData: args.pluginData, with: args.with }
          return {
            external: true,
            path: "external-context",
          }
        })
      },
    }

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", plugins: [externalPlugin] })

    await expect(readFile(outfile, "utf8")).resolves.toContain('from "external-context"')
    expect(resolverContext).toEqual({ pluginData: importerData, with: { type: "text" } })
  })

  it("rejects non-file raw fallback results with a targeted error", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(entry, 'import context from "virtual:context?raw"\nexport default context\n', "utf8")
    const virtualPlugin: Plugin = {
      name: "virtual-context",
      setup(build) {
        build.onResolve({ filter: /^virtual:context$/ }, () => ({
          namespace: "virtual-context",
          path: "context",
        }))
        build.onLoad({ filter: /.*/, namespace: "virtual-context" }, () => ({
          contents: "virtual contents",
          loader: "text",
        }))
      },
    }

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await expect(bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", plugins: [virtualPlugin] }))
      .rejects.toThrow('Vite raw fallback cannot load "virtual:context?raw" from the "virtual-context" namespace')
  })

  it("keeps CommonJS globals available in Node ESM bundles", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(entry, "export default () => ({ dirname: __dirname, filename: __filename, requireType: typeof require })\n", "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node" })

    const bundled = await readFile(outfile, "utf8")
    expect(bundled).toContain("if (globalThis.process?.getBuiltinModule && import.meta.url) {")
    expect(bundled).toContain('globalThis.__filename = globalThis.process.getBuiltinModule("node:url").fileURLToPath(import.meta.url);')
    expect(bundled).not.toMatch(/(?:const|let|var|import).*__vitehub/)
    // SAFETY: This entry exports a function returning the three tested CommonJS values.
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: () => { dirname: string, filename: string, requireType: string } }
    expect(loaded.default()).toEqual({
      dirname: dirname(outfile),
      filename: outfile,
      requireType: "function",
    })

    const commonjs = await transform(bundled, { format: "cjs", logLevel: "silent", target: "node24" })
    expect(() => runInNewContext(commonjs.code, { exports: {}, module: { exports: {} } })).not.toThrow()
  })

  it("does not redeclare Netlify runtime filename globals", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(entry, "export default () => ({ filename: __filename, requireType: typeof require })\n", "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", minifyIdentifiers: true, platform: "node" })

    const bundled = await readFile(outfile, "utf8")
    expect(bundled).not.toContain("var __filename")
    expect(bundled).not.toContain("const __filename")
    await writeFile(outfile, `${bundled}\nconst __filename = "netlify-runtime";\n`, "utf8")

    // SAFETY: This entry exports a function returning the two tested CommonJS values.
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: () => { filename: string, requireType: string } }
    expect(loaded.default()).toEqual({
      filename: "netlify-runtime",
      requireType: "function",
    })
  })

  it("resolves package entry fields in neutral bundles", async () => {
    const rootDir = await createTempDir()
    const packageDir = join(rootDir, "node_modules", "main-only-package")
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ main: "index.js", name: "main-only-package", type: "module" }), "utf8")
    await writeFile(join(packageDir, "index.js"), "export const value = 'neutral-main'\n", "utf8")
    await writeFile(entry, "import { value } from 'main-only-package'\nexport default value\n", "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "neutral" })

    // SAFETY: This bundle's entry module exports the package's string default export.
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: string }
    expect(loaded.default).toBe("neutral-main")
  })

  it("applies explicit Vite prefix aliases to subpaths", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const targetDir = join(rootDir, "target")
    const outfile = join(rootDir, "bundle.mjs")
    await mkdir(targetDir)
    await writeFile(entry, 'import value from "@/jobs.mjs"\nexport default value\n', "utf8")
    await writeFile(join(targetDir, "jobs.mjs"), 'export default "aliased subpath"\n', "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: {
        "@/": `${targetDir}/`,
      },
      format: "esm",
      platform: "node",
    })

    // SAFETY: This bundle's entry module exports the linked package's string default export.
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: string }
    expect(loaded.default).toBe("aliased subpath")
  })

  it("applies package aliases only to the exact public specifier", async () => {
    const rootDir = await createTempDir()
    const packageDir = join(rootDir, "node_modules", "exact-alias")
    const entry = join(rootDir, "entry.mjs")
    const target = join(rootDir, "target.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ exports: { "./errors": "./errors.mjs" }, type: "module" }), "utf8")
    await writeFile(join(packageDir, "errors.mjs"), 'export default "public subpath"\n', "utf8")
    await writeFile(entry, 'import root from "exact-alias"\nimport errors from "exact-alias/errors"\nexport default { errors, root }\n', "utf8")
    await writeFile(target, 'export default "aliased root"\n', "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { "exact-alias": target },
      format: "esm",
      platform: "node",
    })

    // SAFETY: This bundle exports values from the exact alias and the untouched package subpath.
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: { errors: string, root: string } }
    expect(loaded.default).toEqual({ errors: "public subpath", root: "aliased root" })
  })

  it("resolves bare package alias replacements", async () => {
    const rootDir = await createTempDir()
    const packageDir = join(rootDir, "node_modules", "alias-target")
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ exports: "./index.mjs", type: "module" }), "utf8")
    await writeFile(join(packageDir, "index.mjs"), 'export default "bare replacement"\n', "utf8")
    await writeFile(entry, 'import value from "alias-source"\nexport default value\n', "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { "alias-source": "alias-target" },
      format: "esm",
      platform: "node",
    })

    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
    expect(loaded.default).toBe("bare replacement")
  })

  it("prefers Node exports over module exports in Node bundles", async () => {
    const rootDir = await createTempDir()
    const packageDir = join(rootDir, "node_modules", "conditional-package")
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    const requireEntry = join(rootDir, "require-entry.cjs")
    const requireOutfile = join(rootDir, "require-bundle.mjs")
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      exports: {
        ".": {
          module: "./module.mjs",
          require: "./require.cjs",
          node: "./node.mjs",
          default: "./default.mjs",
        },
      },
      name: "conditional-package",
      type: "module",
    }), "utf8")
    await writeFile(join(packageDir, "module.mjs"), 'export default "module"\n', "utf8")
    await writeFile(join(packageDir, "node.mjs"), 'export default "node"\n', "utf8")
    await writeFile(join(packageDir, "require.cjs"), 'module.exports = "require"\n', "utf8")
    await writeFile(join(packageDir, "default.mjs"), 'export default "default"\n', "utf8")
    await writeFile(entry, 'import value from "conditional-package"\nexport default value\n', "utf8")
    await writeFile(requireEntry, 'module.exports = require("conditional-package")\n', "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node" })

    // SAFETY: This ESM bundle exports the selected conditional string.
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: string }
    expect(loaded.default).toBe("node")

    await bundleEsmEntry(requireEntry, requireOutfile, { format: "esm", platform: "node" })
    // SAFETY: This bundle's CommonJS entry exports the selected string condition.
    const requireLoaded = await import(`${pathToFileURL(requireOutfile).href}?t=${Date.now()}`) as { default: string }
    expect(requireLoaded.default).toBe("require")
  })
})
