import { existsSync } from "node:fs"
import { execFile as execFileCallback } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, relative, resolve } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import {
  collectDenoRuntimePackageNames,
  finalizeDenoDeploymentOutput,
} from "../src/build/deno-runtime-packages.ts"

const execFile = promisify(execFileCallback)

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value), "utf8")
}

async function writeRuntimePackage(root: string, name: string, packageJson: Record<string, unknown> = {}): Promise<void> {
  const packageDir = join(root, "node_modules", ...name.split("/"))
  await writeJson(join(packageDir, "package.json"), { name, version: "9.9.9", ...packageJson })
  await writeFile(join(packageDir, "marker"), name, "utf8")
}

async function directorySize(directory: string): Promise<number> {
  let size = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    size += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size
  }
  return size
}

interface DeployInvocation {
  args: string[]
  cwd: string
  entry?: boolean
  legacyEntry?: boolean
  libvips?: boolean
  sharp?: boolean
}

function parseDeployInvocation(source: string): DeployInvocation {
  const value: unknown = JSON.parse(source)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a deployment invocation object.")
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.args) || !record.args.every(argument => typeof argument === "string") || typeof record.cwd !== "string") throw new Error("Expected deployment invocation arguments and cwd.")
  return { ...record, args: record.args, cwd: record.cwd } as DeployInvocation
}

describe("Deno deployment output", () => {
  it("finds external packages without treating runtime protocols as npm packages", () => {
    expect(
      collectDenoRuntimePackageNames(
        'import sharp from "sharp";import{image}from "minified-image";export{tool}from"minified-tool"; const tool = ready ? await import("@scope/tool/subpath") : undefined; module.exports = require("native-addon"); const commonjs = __require("commonjs-runtime"); import "node:path"; import "cloudflare:workers"\n//#region node_modules/.pnpm/native-addon@1.0.0/node_modules/native-addon/index.js\n/** @example const got = require("got") */',
      ),
    ).toEqual(["@scope/tool", "commonjs-runtime", "minified-image", "minified-tool", "native-addon", "sharp"])
  })

  it("finds literal dynamic imports with attributes", () => {
    expect(collectDenoRuntimePackageNames(`
await import("data-package", { with: { type: "json" } })
await import("identifier-options", importOptions)
await import("function-options", createImportOptions())
await import(\`template-package\`)
await import(\`escaped\\u002dtemplate-package\`)
`)).toEqual(["data-package", "escaped-template-package", "function-options", "identifier-options", "template-package"])
  })

  it("ignores import- and require-shaped member calls", () => {
    expect(collectDenoRuntimePackageNames(`
loader.import("member-data", { with: { type: "json" } })
this.#import("private-member-data")
loader.require("member-require")
loader.__require("member-helper-require")
loader.require.resolve("member-resolve")
loader.__require.resolve("member-helper-resolve")
loader?.require("optional-member-require")
loader?.require.resolve("optional-member-resolve")
loader . require("spaced-member-require")
loader . __require("spaced-member-helper-require")
loader . require . resolve("spaced-member-resolve")
loader ?. require("spaced-optional-member-require")
loader ?. require . resolve("spaced-optional-member-resolve")
loader /* receiver */ . /* call */ require("commented-member-require")
this.#require("private-member-require")
`))
      .toEqual([])
  })

  it("stages literal imports with expression options without resolving member calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-import-options-"))
    await writeRuntimePackage(root, "data-package")
    await writeRuntimePackage(root, "commonjs-runtime")
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/helper.cjs"), 'module.exports = require("commonjs-runtime")\n', "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), `
import "./helper.cjs"
const importOptions = { with: { type: "json" } }
const loader = { import: () => {}, require: Object.assign(() => {}, { resolve: () => {} }) }
loader.import("member-data", importOptions)
loader . require("member-require")
loader ?. require . resolve("member-resolve")
class Loader { #import = () => {}; load() { this.#import("private-member-data", importOptions) } }
await import("data-package", importOptions)
`, "utf8")
    await writeFile(join(root, "main.ts"), 'await import("./schedule/deno-cron.mjs")\nawait import("./server/index.mjs")\n', "utf8")

    await finalizeDenoDeploymentOutput({ rootDir: root })

    await expect(readFile(join(root, ".output/node_modules/data-package/marker"), "utf8")).resolves.toBe("data-package")
    await expect(readFile(join(root, ".output/node_modules/commonjs-runtime/marker"), "utf8")).resolves.toBe("commonjs-runtime")
    expect(existsSync(join(root, ".output/node_modules/member-data"))).toBe(false)
    expect(existsSync(join(root, ".output/node_modules/member-require"))).toBe(false)
    expect(existsSync(join(root, ".output/node_modules/member-resolve"))).toBe(false)
    expect(existsSync(join(root, ".output/node_modules/private-member-data"))).toBe(false)
  })

  it("ignores import comments", () => {
    expect(collectDenoRuntimePackageNames('// import("fake")\nimport "real"')).toEqual(["real"])
  })

  it("ignores import-shaped strings and inline comments", () => {
    expect(collectDenoRuntimePackageNames(`
const requireText = 'require("missing-require")'
const importText = \`import("missing-import")\`
doThing() // import("missing-comment")
import "real"
`)).toEqual(["real"])
  })

  it("ignores import-shaped regular expression literals", () => {
    expect(collectDenoRuntimePackageNames(String.raw`
const matcher = /import\("healthcheck"\)/
const characterClass = /[\\/]require\("missing"\)/g
if (ready) {} /import\("after-block"\)/.test(value)
if (ready) { if (nested) {} } /import\("after-nested-if"\)/.test(value)
switch (value) {} /import\("after-switch"\)/.test(value)
try {} catch (error) {} /import\("after-catch"\)/.test(value)
block: {} /import("after-labeled-block")/.test(value)
label: { if (ready) {} } /import("after-nested-labeled-block")/.test(value)
if (import("paren-)")) /import("after-import-parenthesis")/.test(value)
if (ready) { import("brace-}") } /import("after-import-brace")/.test(value)
try {} catch {} /import("after-optional-catch")/.test(value)
while (ready) /require\("after-condition"\)/.test(value)
try {} finally {} /import\("after-finally"\)/.test(value)
function done() {} /import\("after-function"\)/.test(value)
class Ready {} /require\("after-class"\)/.test(value)
export default function() {} /import\("after-anonymous-function"\)/.test(value)
export default class {} /require\("after-anonymous-class"\)/.test(value)
import "real"
`)).toEqual(["brace-}", "paren-)", "real"])
  })

  it("finds imports after division by masked literals", () => {
    expect(collectDenoRuntimePackageNames('const ratio="1"/2;import("real-package")')).toEqual(["real-package"])
    expect(collectDenoRuntimePackageNames('const ratio=/1//2;import("real-package")')).toEqual(["real-package"])
    expect(collectDenoRuntimePackageNames('const ratio=i++/2;import("real-package")')).toEqual(["real-package"])
    expect(collectDenoRuntimePackageNames('const ratio=i--/2;import("real-package")')).toEqual(["real-package"])
    expect(collectDenoRuntimePackageNames('const ratio={ nested: {} }/import("division-package")')).toEqual(["division-package"])
  })

  it("stages explicit Deno Schedule entrypoints for local runs and deployment", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-schedule-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await mkdir(join(root, "server/schedules"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, "server/schedules/heartbeat.ts"), 'import { randomUUID } from "crypto"\nexport default { run() { return `heartbeat-${randomUUID()}` } }\n', "utf8")
    await writeFile(join(root, ".vitehub/schedule/registry.mjs"), 'export default { heartbeat: () => import("../../server/schedules/heartbeat.ts") }\n', "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), 'import registry from "./registry.mjs"\nglobalThis.schedule = registry.heartbeat\n', "utf8")
    await mkdir(join(root, "server"), { recursive: true })
    await writeFile(join(root, "server/instrumentation.ts"), 'globalThis.instrumented = "application-helper"\n', "utf8")
    await writeFile(join(root, "main.ts"), 'import "./server/instrumentation.ts"\nawait import("./schedule/deno-cron.mjs")\nawait import("./server/index.mjs")\n', "utf8")

    await finalizeDenoDeploymentOutput({ rootDir: root })

    const applicationBundle = await readFile(join(root, ".output/main.ts"), "utf8")
    expect(applicationBundle).toContain("application-helper")
    expect(applicationBundle).not.toContain("./instrumentation.ts")
    expect(applicationBundle).toContain("./schedule/deno-cron.mjs")
    const scheduleBundle = await readFile(join(root, ".output/schedule/deno-cron.mjs"), "utf8")
    expect(scheduleBundle).toContain("heartbeat")
    expect(scheduleBundle).toContain('from "crypto"')
    expect(scheduleBundle).not.toContain("./registry.mjs")
    expect(scheduleBundle).not.toContain("../../server/schedules/heartbeat.ts")
    await expect(readFile(join(root, ".output/deno.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      deploy: { runtime: { mode: "dynamic", entrypoint: "./main.ts", cwd: "." } },
      tasks: { start: "deno run --unstable-cron -A ./main.ts" },
    })
    await expect(execFile("deno", ["check", "--config", join(root, ".output/deno.json"), join(root, ".output/main.ts")])).resolves.toMatchObject({ stderr: "" })
    await expect(readFile(join(root, ".output/deploy.mjs"), "utf8")).resolves.toContain('const entrypoint = "main.ts"')
  })

  it("bundles package import mappings into relocated entrypoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-package-imports-"))
    await writeJson(join(root, "package.json"), { imports: { "#config": "./config.ts" } })
    await writeFile(join(root, "config.ts"), 'export default "mapped-config"\n', "utf8")
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), 'import config from "#config"\nglobalThis.scheduleConfig = config\n', "utf8")
    await writeFile(join(root, "main.ts"), 'import config from "#config"\nglobalThis.entryConfig = config\nawait import("./schedule/deno-cron.mjs")\nawait import("./server/index.mjs")\n', "utf8")

    await finalizeDenoDeploymentOutput({ rootDir: root })

    await expect(readFile(join(root, ".output/main.ts"), "utf8")).resolves.toContain("mapped-config")
    await expect(readFile(join(root, ".output/schedule/deno-cron.mjs"), "utf8")).resolves.toContain("mapped-config")
  })

  it("rejects computed local application imports that cannot survive relocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-computed-entry-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, "main.ts"), 'await import(new URL("./helper.ts", import.meta.url).href)\n', "utf8")

    await expect(finalizeDenoDeploymentOutput({ rootDir: root })).rejects.toThrow(
      'unsupported computed local import "./helper.ts"',
    )
  })

  it("rejects computed local imports in relocated Schedule bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-computed-schedule-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), 'await import(new URL("./helper.ts", import.meta.url).href)\n', "utf8")
    await writeFile(join(root, "main.ts"), 'await import("./schedule/deno-cron.mjs")\nawait import("./server/index.mjs")\n', "utf8")

    await expect(finalizeDenoDeploymentOutput({ rootDir: root })).rejects.toThrow(
      'Deno Schedule bundle contains an unsupported computed local import "./helper.ts"',
    )
    expect(existsSync(join(root, ".output/schedule/deno-cron.mjs"))).toBe(false)
  })

  it("rejects computed application imports through an intermediate base", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-computed-base-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, "main.ts"), 'const base = import.meta.url\nawait import(new URL("./helper.ts", base).href)\n', "utf8")

    await expect(finalizeDenoDeploymentOutput({ hasScheduleIntegration: true, rootDir: root })).rejects.toThrow(
      "unsupported computed import",
    )
  })

  it("rejects computed imports whose first operand is a string literal", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-computed-string-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, "main.ts"), 'await import("./helper.ts".slice(0))\n', "utf8")

    await expect(finalizeDenoDeploymentOutput({ hasScheduleIntegration: true, rootDir: root })).rejects.toThrow(
      "unsupported computed import",
    )
  })

  it("rejects computed local application imports inside template interpolations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-computed-template-entry-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, "main.ts"), '`${await import(new URL("./helper.ts", import.meta.url).href)}`\n', "utf8")

    await expect(finalizeDenoDeploymentOutput({ hasScheduleIntegration: true, rootDir: root })).rejects.toThrow(
      'unsupported computed local import "./helper.ts"',
    )
  })

  it("rejects computed imports retained from bundled application helpers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-computed-helper-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, "helper.ts"), 'const base = import.meta.url\nawait import(new URL("./child.ts", base).href)\n', "utf8")
    await writeFile(join(root, "main.ts"), 'import "./helper.ts"\nawait import("./schedule/deno-cron.mjs")\nawait import("./server/index.mjs")\n', "utf8")

    await expect(finalizeDenoDeploymentOutput({ hasScheduleIntegration: true, rootDir: root })).rejects.toThrow(
      "unsupported computed import",
    )
    expect(existsSync(join(root, ".output/main.ts"))).toBe(false)
  })

  it("ignores inert computed-import text in Deno application entrypoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-inert-import-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, "main.ts"), 'const example = `import(new URL("./example.ts", import.meta.url).href)`\n// import(new URL("./comment.ts", import.meta.url).href)\nawait import("./schedule/deno-cron.mjs")\nawait import("./server/index.mjs")\n', "utf8")

    await expect(finalizeDenoDeploymentOutput({ hasScheduleIntegration: true, rootDir: root })).resolves.toBeUndefined()
  })

  it("rejects custom alias resolvers only when a staged entrypoint uses the alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-custom-alias-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")

    await expect(finalizeDenoDeploymentOutput({ rootDir: root })).resolves.toBeUndefined()

    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), 'import "#server-only"\n', "utf8")
    await writeFile(join(root, "main.ts"), "void 0\n", "utf8")
    await writeFile(join(root, "server.ts"), "void 0\n", "utf8")
    const alias = [
      { customResolver: true, find: "#client-only", replacement: join(root, "client.ts") },
      { find: "#server-only", replacement: join(root, "server.ts") },
    ]
    await expect(finalizeDenoDeploymentOutput({ alias, hasScheduleIntegration: true, rootDir: root })).resolves.toBeUndefined()

    alias[1]!.customResolver = true
    await expect(finalizeDenoDeploymentOutput({ alias, hasScheduleIntegration: true, rootDir: root })).rejects.toThrow(
      "uses customResolver",
    )
  })

  it("stages external Schedule packages and their native optional dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-schedule-package-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeRuntimePackage(root, "image-package", { optionalDependencies: { "image-package-linux-x64": "9.9.9" } })
    await writeRuntimePackage(root, "image-package-linux-x64", { cpu: ["x64"], os: ["linux"] })
    await writeFile(join(root, "node_modules/image-package/index.js"), 'import "image-package-linux-x64"\nexport default true\n', "utf8")
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), 'import image from "image-package"\nglobalThis.image = image\n', "utf8")
    await writeFile(join(root, "main.ts"), 'await import("./schedule/deno-cron.mjs")\nawait import("./server/index.mjs")\n', "utf8")

    await finalizeDenoDeploymentOutput({ rootDir: root })

    expect(existsSync(join(root, ".output/node_modules/image-package/package.json"))).toBe(true)
    expect(existsSync(join(root, ".output/node_modules/image-package/node_modules/image-package-linux-x64/package.json"))).toBe(true)
  })

  it("stages external application packages and their native optional dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-entry-package-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeRuntimePackage(root, "image-package", { optionalDependencies: { "image-package-linux-x64": "9.9.9" } })
    await writeRuntimePackage(root, "image-package-linux-x64", { cpu: ["x64"], os: ["linux"] })
    await writeFile(join(root, "node_modules/image-package/index.js"), 'export default "image"\n', "utf8")
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, "main.ts"), 'import image from "image-package"\nglobalThis.image = image\nawait import("./schedule/deno-cron.mjs")\nawait import("./server/index.mjs")\n', "utf8")

    await finalizeDenoDeploymentOutput({ rootDir: root })

    await expect(readFile(join(root, ".output/main.ts"), "utf8")).resolves.toContain('from "image-package"')
    expect(existsSync(join(root, ".output/node_modules/image-package/package.json"))).toBe(true)
    expect(existsSync(join(root, ".output/node_modules/image-package/node_modules/image-package-linux-x64/package.json"))).toBe(true)
  })

  it("stages literal dynamic application and Schedule imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-import-attributes-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeRuntimePackage(root, "application-data-package")
    await writeRuntimePackage(root, "schedule-data-package")
    await writeRuntimePackage(root, "application-template-package")
    await writeRuntimePackage(root, "schedule-template-package")
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), 'await import("schedule-data-package", { with: { type: "json" } })\nawait import(`schedule-template-package`)\n', "utf8")
    await writeFile(join(root, "main.ts"), 'await import("application-data-package", { with: { type: "json" } })\nawait import(`application-template-package`)\nawait import("./schedule/deno-cron.mjs")\nawait import("./server/index.mjs")\n', "utf8")

    await finalizeDenoDeploymentOutput({ rootDir: root })

    expect(existsSync(join(root, ".output/node_modules/application-data-package/package.json"))).toBe(true)
    expect(existsSync(join(root, ".output/node_modules/schedule-data-package/package.json"))).toBe(true)
    expect(existsSync(join(root, ".output/node_modules/application-template-package/package.json"))).toBe(true)
    expect(existsSync(join(root, ".output/node_modules/schedule-template-package/package.json"))).toBe(true)
  })

  it("stages escaped literal imports from generated server output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-server-template-package-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await writeRuntimePackage(root, "server-template-package")
    await writeFile(join(root, ".output/server/index.mjs"), "await import(`server\\u002dtemplate-package`)\n", "utf8")

    await finalizeDenoDeploymentOutput({ rootDir: root })

    await expect(readFile(join(root, ".output/node_modules/server-template-package/marker"), "utf8"))
      .resolves.toBe("server-template-package")
  })

  it("preserves regex aliases while staging Deno entrypoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-regex-alias-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), 'import value from "virtual/helper"\nglobalThis.scheduleValue = value\n', "utf8")
    await writeFile(join(root, "src/helper.ts"), 'export default "aliased"\n', "utf8")
    await writeFile(join(root, "main.ts"), 'import value from "virtual/helper"\nglobalThis.entryValue = value\nawait import("./schedule/deno-cron.mjs")\nawait import("./server/index.mjs")\n', "utf8")

    await finalizeDenoDeploymentOutput({
      alias: [{ find: /^virtual\/(.*)$/, replacement: join(root, "src/$1") }],
      rootDir: root,
    })

    await expect(readFile(join(root, ".output/main.ts"), "utf8")).resolves.toContain("aliased")
    await expect(readFile(join(root, ".output/schedule/deno-cron.mjs"), "utf8")).resolves.toContain("aliased")
  })

  it("uses Vite resolve conditions for Deno entrypoint bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-conditions-"))
    await mkdir(join(root, ".output/server"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    await writeJson(join(root, "package.json"), {
      imports: {
        "#conditional": {
          launch: "./src/launch.ts",
          default: "./src/default.ts",
        },
      },
    })
    await writeFile(join(root, ".output/server/index.mjs"), "void 0\n", "utf8")
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), 'import value from "#conditional"\nglobalThis.scheduleValue = value\n', "utf8")
    await writeFile(join(root, "main.ts"), 'import value from "#conditional"\nglobalThis.entryValue = value\nawait import("./schedule/deno-cron.mjs")\nawait import("./server/index.mjs")\n', "utf8")
    await writeFile(join(root, "src/launch.ts"), 'export default "launch-condition"\n', "utf8")
    await writeFile(join(root, "src/default.ts"), 'export default "default-condition"\n', "utf8")

    await finalizeDenoDeploymentOutput({ conditions: ["launch"], hasScheduleIntegration: true, rootDir: root })

    for (const file of ["main.ts", "schedule/deno-cron.mjs"]) {
      const source = await readFile(join(root, ".output", file), "utf8")
      expect(source).toContain("launch-condition")
      expect(source).not.toContain("default-condition")
    }
  })

  it("filters optional packages for Deno runtimes and hoists the selected closure once", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-platforms-"))
    const outputNodeModules = join(root, ".output/node_modules")
    await writeJson(join(root, "package.json"), {})
    await writeRuntimePackage(root, "runtime-root", {
      dependencies: {
        "native-duplicate-darwin": "9.9.9",
        "regular-parent": "9.9.9",
      },
      optionalDependencies: {
        "native-any": "9.9.9",
        "native-darwin-x64": "9.9.9",
        "native-duplicate-darwin": "9.9.9",
        "native-lib-linux-arm64": "9.9.9",
        "native-lib-linux-x64": "9.9.9",
        "native-lib-linuxmusl-x64": "9.9.9",
        "native-linux-arm": "9.9.9",
        "native-linux-arm64": "9.9.9",
        "native-linux-x64": "9.9.9",
        "native-linuxmusl-x64": "9.9.9",
        "native-not-darwin": "9.9.9",
        "native-wasm32": "9.9.9",
        "native-win32-x64": "9.9.9",
      },
    })
    await writeRuntimePackage(root, "required-darwin", { cpu: ["x64"], os: ["darwin"] })
    await writeRuntimePackage(root, "regular-parent", { optionalDependencies: { "regular-native": "9.9.9" } })
    await writeRuntimePackage(root, "regular-native", { cpu: ["x64"], os: ["linux"] })
    await writeRuntimePackage(root, "native-any", { os: ["any"] })
    await writeRuntimePackage(root, "native-duplicate-darwin", { cpu: ["x64"], os: ["darwin"] })
    await writeRuntimePackage(root, "native-lib-linux-arm64", { cpu: ["arm64"], libc: ["glibc"], os: ["linux"] })
    await writeRuntimePackage(root, "native-lib-linux-x64", { cpu: ["x64"], libc: ["glibc"], os: ["linux"] })
    await writeRuntimePackage(root, "native-lib-linuxmusl-x64", { cpu: ["x64"], libc: ["musl"], os: ["linux"] })
    await writeRuntimePackage(root, "native-linux-arm64", {
      cpu: ["arm64"],
      libc: ["glibc"],
      optionalDependencies: { "native-lib-linux-arm64": "9.9.9" },
      os: ["linux"],
    })
    await writeRuntimePackage(root, "native-linux-x64", {
      cpu: ["x64"],
      libc: ["glibc"],
      optionalDependencies: { "native-lib-linux-x64": "9.9.9" },
      os: ["linux"],
    })
    await writeRuntimePackage(root, "native-linuxmusl-x64", {
      cpu: ["x64"],
      libc: ["musl"],
      optionalDependencies: { "native-lib-linuxmusl-x64": "9.9.9" },
      os: ["linux"],
    })
    await writeRuntimePackage(root, "native-darwin-x64", { cpu: ["x64"], os: ["darwin"] })
    await writeRuntimePackage(root, "native-linux-arm", { cpu: ["arm"], os: ["linux"] })
    await writeRuntimePackage(root, "native-not-darwin", { os: ["!darwin"] })
    await writeRuntimePackage(root, "native-wasm32", { cpu: ["wasm32"] })
    await writeRuntimePackage(root, "native-win32-x64", { cpu: ["x64"], os: ["win32"] })
    await mkdir(join(root, ".output/server"), { recursive: true })
    await writeFile(
      join(root, ".output/server/index.mjs"),
      '//#region node_modules/runtime-root/index.js\nimport "required-darwin"\n',
    )

    await finalizeDenoDeploymentOutput({ rootDir: root })

    for (const name of [
      "native-any",
      "native-lib-linux-arm64",
      "native-lib-linux-x64",
      "native-linux-arm64",
      "native-linux-x64",
      "native-not-darwin",
      "required-darwin",
    ]) expect(existsSync(join(outputNodeModules, name, "package.json"))).toBe(true)
    for (const name of [
      "native-darwin-x64",
      "native-duplicate-darwin",
      "native-lib-linuxmusl-x64",
      "native-linux-arm",
      "native-linuxmusl-x64",
      "native-wasm32",
      "native-win32-x64",
    ]) expect(existsSync(join(outputNodeModules, name, "package.json"))).toBe(false)
    expect(existsSync(join(outputNodeModules, "native-linux-x64/node_modules/native-lib-linux-x64"))).toBe(false)
    expect(existsSync(join(outputNodeModules, "native-linux-arm64/node_modules/native-lib-linux-arm64"))).toBe(false)
    expect(existsSync(join(outputNodeModules, "runtime-root/node_modules/regular-parent/node_modules/regular-native/package.json"))).toBe(true)
    expect(existsSync(join(outputNodeModules, "runtime-root/node_modules/regular-native"))).toBe(false)
  })

  it("stages reachable packages and their installed optional native dependencies", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-deno-output-"))
    const outputDir = join(rootDir, ".output")
    const sharpDir = join(rootDir, "node_modules", "sharp")
    const nativeDir = join(rootDir, "node_modules", "@img", "sharp-linux-x64")
    const libvipsDir = join(rootDir, "node_modules", "@img", "sharp-libvips-linux-x64")

    await mkdir(join(outputDir, "server"), { recursive: true })
    await writeFile(
      join(outputDir, "server", "index.mjs"),
      '//#region node_modules/.pnpm/sharp@9.9.9/node_modules/sharp/index.js\nvoid 0\n',
      "utf8",
    )
    await writeJson(join(rootDir, "package.json"), { private: true })
    await writeJson(join(sharpDir, "package.json"), {
      name: "sharp",
      version: "9.9.9",
      main: "index.js",
      optionalDependencies: {
        "@img/sharp-libvips-linux-x64": "9.9.9",
        "@img/sharp-linux-x64": "9.9.9",
      },
    })
    await writeFile(join(sharpDir, "index.js"), "export default {}\n", "utf8")
    await writeJson(join(nativeDir, "package.json"), {
      name: "@img/sharp-linux-x64",
      version: "9.9.9",
      exports: { "./sharp.node": "./lib/sharp-linux-x64.node" },
      optionalDependencies: { "@img/sharp-libvips-linux-x64": "9.9.9" },
    })
    await mkdir(join(nativeDir, "lib"), { recursive: true })
    await writeFile(join(nativeDir, "lib/sharp-linux-x64.node"), "native", "utf8")
    await writeJson(join(libvipsDir, "package.json"), {
      name: "@img/sharp-libvips-linux-x64",
      version: "9.9.9",
      exports: { "./lib": "./lib/index.js" },
    })
    await mkdir(join(libvipsDir, "lib"), { recursive: true })
    await writeFile(join(libvipsDir, "lib/index.js"), "export default {}\n", "utf8")
    await writeFile(join(libvipsDir, "lib/libvips-cpp.so.9"), "native", "utf8")

    await finalizeDenoDeploymentOutput({ deploymentName: "package-default", rootDir })

    expect(existsSync(join(outputDir, "node_modules", "@img", "sharp-linux-x64", "lib/sharp-linux-x64.node"))).toBe(true)
    expect(existsSync(join(outputDir, "node_modules", "@img", "sharp-libvips-linux-x64", "lib/libvips-cpp.so.9"))).toBe(true)
    await expect(
      readFile(join(outputDir, "deno.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({ nodeModulesDir: "manual" })
    const deployRunner = await readFile(join(outputDir, "deploy.mjs"), "utf8")
    expect(deployRunner).toContain('process.env.DENO_DEPLOY_APP || "package-default"')
    for (const text of ["DENO_DEPLOY_ORG", '["deploy", "create"', "--do-not-use-detected-build-config", "--allow-node-modules", 'const entrypoint = "server/index.mjs"', "creation.signal != null && !interrupted", '["deploy", ".", "--prod", "--config", "deno.json"', 'const common = ["--allow-node-modules", "--org", organization, "--app", app]', "mkdtemp", "finally"]) expect(deployRunner).toContain(text)
    await expect(readFile(join(outputDir, "deno.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      deploy: { runtime: { mode: "dynamic", entrypoint: "./server/index.mjs", cwd: "." } },
    })
    expect(deployRunner).not.toContain("DENO_DEPLOY_NODE_MODULES_ENABLED")
    expect(deployRunner.indexOf("if (!interrupted) {")).toBeLessThan(deployRunner.indexOf('const common = ["--allow-node-modules"'))
  })

  it("uses the pnpm package from a bundle marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-pnpm-"))
    const bundled = join(root, "node_modules/.pnpm/sharp@2/node_modules/sharp/package.json")
    await writeJson(join(root, "package.json"), {})
    await writeJson(join(root, "node_modules/sharp/package.json"), { name: "sharp", version: "1" })
    await writeJson(bundled, { name: "sharp", version: "2", optionalDependencies: { native: "2" } })
    await writeJson(join(dirname(bundled), "node_modules/native/package.json"), { name: "native", version: "2" })
    await mkdir(join(root, ".output/server"), { recursive: true })
    await writeFile(join(root, ".output/server/index.ts"), `//#region node_modules/.pnpm/sharp@2/node_modules/sharp/index.js
import "sharp"
`)
    await finalizeDenoDeploymentOutput({ rootDir: root })
    await expect(readFile(join(root, ".output/node_modules/sharp/package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ version: "2" })
    await expect(readFile(join(root, ".output/node_modules/native/package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ version: "2" })
  })

  it("preserves bundle-marker paths above a nested Vite root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vitehub-deno-monorepo-"))
    const root = join(workspace, "apps/api")
    const bundledDir = join(workspace, "node_modules/.pnpm/sharp@2/node_modules/sharp")
    await writeJson(join(root, "package.json"), {})
    await writeJson(join(bundledDir, "package.json"), { name: "sharp", optionalDependencies: { native: "2" }, version: "2" })
    await writeJson(join(dirname(bundledDir), "node_modules/native/package.json"), { name: "native", version: "2" })
    await mkdir(join(root, ".output/server"), { recursive: true })
    await writeFile(
      join(root, ".output/server/index.ts"),
      `//#region ${relative(root, bundledDir).replaceAll("\\", "/")}/index.js\n`,
    )

    await finalizeDenoDeploymentOutput({ rootDir: root })

    await expect(readFile(join(root, ".output/node_modules/sharp/package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ version: "2" })
    await expect(readFile(join(root, ".output/node_modules/native/package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ version: "2" })
  })

  it("stages a required package that also has a bundle marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-required-marker-"))
    await writeJson(join(root, "package.json"), {})
    await writeJson(join(root, "node_modules/plain/package.json"), { name: "plain", version: "1" })
    await mkdir(join(root, ".output/server"), { recursive: true })
    await writeFile(join(root, ".output/server/index.ts"), `//#region node_modules/plain/index.js
import "plain"
`)

    await finalizeDenoDeploymentOutput({ rootDir: root })

    await expect(readFile(join(root, ".output/node_modules/plain/package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ version: "1" })
  })

  it("stages packages referenced through require.resolve", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-require-resolve-"))
    await writeJson(join(root, "package.json"), {})
    await writeRuntimePackage(root, "direct-runtime")
    await writeRuntimePackage(root, "@scope/bundled-runtime")
    await mkdir(join(root, ".output/server"), { recursive: true })
    await writeFile(join(root, ".output/server/index.mjs"), `
require.resolve("direct-runtime")
__require.resolve("@scope/bundled-runtime/entry")
`)

    await finalizeDenoDeploymentOutput({ rootDir: root })

    await expect(readFile(join(root, ".output/node_modules/direct-runtime/marker"), "utf8")).resolves.toBe("direct-runtime")
    await expect(readFile(join(root, ".output/node_modules/@scope/bundled-runtime/marker"), "utf8")).resolves.toBe("@scope/bundled-runtime")
  })

  it("copies pnpm-style dependency symlinks through the dependency walker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-package-cycle-"))
    const plainDir = join(root, "node_modules/plain")
    const dependencyDir = join(root, "node_modules/dependency")
    await writeJson(join(root, "package.json"), {})
    await writeJson(join(plainDir, "package.json"), { dependencies: { dependency: "1" }, name: "plain", version: "1" })
    await writeJson(join(dependencyDir, "package.json"), { dependencies: { plain: "1" }, name: "dependency", version: "1" })
    await mkdir(join(plainDir, "node_modules"), { recursive: true })
    await mkdir(join(dependencyDir, "node_modules"), { recursive: true })
    await symlink(dependencyDir, join(plainDir, "node_modules/dependency"), "dir")
    await symlink(plainDir, join(dependencyDir, "node_modules/plain"), "dir")
    await mkdir(join(root, ".output/server"), { recursive: true })
    await writeFile(join(root, ".output/server/index.ts"), 'import "plain"\n')

    await finalizeDenoDeploymentOutput({ rootDir: root })

    await expect(readFile(join(root, ".output/node_modules/plain/node_modules/dependency/package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ version: "1" })
  })

  it("does not copy nested development node_modules from runtime packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-nested-node-modules-"))
    const packageDir = join(root, "node_modules/plain")
    await writeJson(join(root, "package.json"), {})
    await writeJson(join(packageDir, "package.json"), { name: "plain", version: "1" })
    await writeFile(join(packageDir, "marker"), "plain", "utf8")
    await mkdir(join(packageDir, "examples/vite/node_modules"), { recursive: true })
    await symlink(packageDir, join(packageDir, "examples/vite/node_modules/plain"), "dir")
    await mkdir(join(root, ".output/server"), { recursive: true })
    await writeFile(join(root, ".output/server/index.ts"), 'import "plain"\n')

    await finalizeDenoDeploymentOutput({ rootDir: root })

    await expect(readFile(join(root, ".output/node_modules/plain/marker"), "utf8")).resolves.toBe("plain")
    expect(existsSync(join(root, ".output/node_modules/plain/examples/vite/node_modules"))).toBe(false)
  })

  it("does not demote imports found before bundle markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-import-before-marker-"))
    await writeJson(join(root, "package.json"), {})
    await writeJson(join(root, "node_modules/plain/package.json"), { name: "plain", version: "1" })
    await mkdir(join(root, ".output/server"), { recursive: true })
    await writeFile(join(root, ".output/server/a-import.ts"), 'import "plain"\n')
    await writeFile(join(root, ".output/server/b-marker.ts"), "//#region node_modules/plain/index.js\n")

    await finalizeDenoDeploymentOutput({ rootDir: root })

    await expect(readFile(join(root, ".output/node_modules/plain/package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ version: "1" })
  })

  it("deploys ignored output from a complete temporary stage and cleans it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-ignored-output-"))
    const output = join(root, ".output")
    const bin = join(root, "bin")
    const invocationsFile = join(root, "invocations.jsonl")
    const failedInvocationsFile = join(root, "failed-invocations.jsonl")
    try {
      await mkdir(join(output, "server"), { recursive: true })
      await mkdir(join(output, "node_modules/@img/sharp-linux-x64/lib"), { recursive: true })
      await mkdir(join(output, "node_modules/@img/sharp-libvips-linux-x64/lib"), { recursive: true })
      await writeFile(join(root, ".gitignore"), ".output/\n", "utf8")
      await writeFile(join(root, "package.json"), "{}\n", "utf8")
      await writeFile(join(output, "server/index.mjs"), "void 0\n", "utf8")
      await writeFile(join(output, "node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node"), "native", "utf8")
      await writeFile(join(output, "node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3"), "native", "utf8")
      await finalizeDenoDeploymentOutput({ rootDir: root })

      await execFile("git", ["init", "--quiet"], { cwd: root })
      const ignored = await execFile("git", ["check-ignore", "--no-index", ".output/server/index.mjs"], { cwd: root })
      expect(ignored.stdout.trim()).toBe(".output/server/index.mjs")
      const uploadable = await execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard", "."], { cwd: output })
      expect(uploadable.stdout.trim()).toBe("")

      await mkdir(bin, { recursive: true })
      const fakeDeno = join(bin, "deno")
      await writeFile(fakeDeno, `#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"

const log = process.env.VITEHUB_DENO_INVOCATIONS
const attempts = existsSync(log) ? (await readFile(log, "utf8")).trim().split("\\n").filter(Boolean).length : 0
await appendFile(log, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  entry: existsSync("server/index.mjs"),
  legacyEntry: existsSync("server/index.ts"),
  sharp: existsSync("node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node"),
  libvips: existsSync("node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3"),
}) + "\\n")
if (process.env.VITEHUB_DENO_SELF_SIGNAL === "1") process.kill(process.pid, "SIGTERM")
process.exit(process.env.VITEHUB_DENO_ALWAYS_FAIL === "1" || attempts === 0 ? 1 : 0)
`, "utf8")
      await chmod(fakeDeno, 0o755)

      const env = {
        ...process.env,
        DENO_DEPLOY_APP: "ignored-output",
        DENO_DEPLOY_ORG: "vitehub",
        PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
        VITEHUB_DENO_INVOCATIONS: invocationsFile,
      }
      await execFile(process.execPath, [join(output, "deploy.mjs")], { env })

      const invocations = (await readFile(invocationsFile, "utf8")).trim().split("\n").map(parseDeployInvocation)
      expect(invocations).toHaveLength(2)
      expect(invocations[0]!.args.slice(0, 3)).toEqual(["deploy", "create", "."])
      expect(invocations[1]!.args.slice(0, 2)).toEqual(["deploy", "."])
      for (const invocation of invocations) {
        expect(relative(root, invocation.cwd).startsWith("..")).toBe(true)
        expect(invocation.args).toContain("--allow-node-modules")
        expect(invocation).toMatchObject({ entry: true, legacyEntry: true, libvips: true, sharp: true })
        expect(existsSync(invocation.cwd)).toBe(false)
      }
      expect(invocations[0]!.cwd).toBe(invocations[1]!.cwd)

      await expect(execFile(process.execPath, [join(output, "deploy.mjs")], {
        env: {
          ...env,
          VITEHUB_DENO_INVOCATIONS: join(root, "signaled-invocations.jsonl"),
          VITEHUB_DENO_SELF_SIGNAL: "1",
        },
      })).rejects.toThrow()

      await expect(execFile(process.execPath, [join(output, "deploy.mjs")], {
        env: {
          ...env,
          VITEHUB_DENO_ALWAYS_FAIL: "1",
          VITEHUB_DENO_INVOCATIONS: failedInvocationsFile,
        },
      })).rejects.toThrow()
      const failedInvocations = (await readFile(failedInvocationsFile, "utf8")).trim().split("\n")
      expect(failedInvocations).toHaveLength(2)
      const failedStages = failedInvocations.map(parseDeployInvocation)
      expect(failedStages[0]!.cwd).toBe(failedStages[1]!.cwd)
      for (const invocation of failedStages) expect(invocation.args).toContain("--allow-node-modules")
      const failedStage = failedStages[1]!
      expect(existsSync(failedStage.cwd)).toBe(false)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("executes staged Sharp with Deno", async () => {
    const output = await mkdtemp(join(tmpdir(), "vitehub-deno-sharp-runtime-"))
    const workspaceRoot = resolve(import.meta.dirname, "../../..")
    const require = createRequire(import.meta.url)
    const sharpPackageJson = await realpath(require.resolve("sharp/package.json"))
    const sharpMarker = relative(workspaceRoot, dirname(sharpPackageJson)).replaceAll("\\", "/")
    try {
      await mkdir(join(output, "server"), { recursive: true })
      const nativeProbe = process.platform === "linux" && process.arch === "x64"
        ? `const require = createRequire(import.meta.url)
const nativePath = require.resolve("@img/" + "sharp-linux-x64/sharp.node")
if (!nativePath.endsWith("/sharp-linux-x64.node")) throw new Error("Sharp's x64 native package did not resolve from the output root")
`
        : ""
      await writeFile(join(output, "server/index.mjs"), `//#region ${sharpMarker}/lib/index.js
import { createRequire } from "node:module"
import sharp from "../node_modules/sharp/lib/index.js"

${nativeProbe}
const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: "#123456" } }).png().toBuffer()
if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) throw new Error("Sharp did not produce a PNG")
process.exit(0)
`, "utf8")
      await finalizeDenoDeploymentOutput({ outputDir: output, rootDir: workspaceRoot })
      expect(await directorySize(join(output, "node_modules"))).toBeLessThan(64 * 1024 * 1024)
      expect(existsSync(join(output, "node_modules/@img/sharp-linux-x64/node_modules/@img/sharp-libvips-linux-x64"))).toBe(false)

      if (process.platform === "linux" && process.arch === "x64") {
        expect(existsSync(join(output, "node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node"))).toBe(true)
        expect(existsSync(join(output, "node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3"))).toBe(true)
      }
      await execFile("deno", ["check", "server/index.mjs"], { cwd: output })
      await execFile("deno", ["check", "server/index.ts"], { cwd: output })
      await execFile("deno", ["run", "-A", join(output, "server/index.mjs")], { cwd: output })
      await execFile("deno", ["run", "-A", join(output, "server/index.ts")], { cwd: output })
    } finally {
      await rm(output, { force: true, recursive: true })
    }
  }, 30_000)
})
