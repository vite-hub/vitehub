import { existsSync } from "node:fs"
import { execFile as execFileCallback } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
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

describe("Deno deployment output", () => {
  it("finds external packages without treating runtime protocols as npm packages", () => {
    expect(
      collectDenoRuntimePackageNames(
        'import sharp from "sharp";import{image}from "minified-image";export{tool}from"minified-tool"; const tool = ready ? await import("@scope/tool/subpath") : undefined; module.exports = require("native-addon"); import "node:path"; import "cloudflare:workers"\n//#region node_modules/.pnpm/native-addon@1.0.0/node_modules/native-addon/index.js\n/** @example const got = require("got") */',
      ),
    ).toEqual(["@scope/tool", "minified-image", "minified-tool", "native-addon", "sharp"])
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

  it("stages reachable packages and their installed optional native dependencies", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-deno-output-"))
    const outputDir = join(rootDir, ".output")
    const sharpDir = join(rootDir, "node_modules", "sharp")
    const nativeDir = join(rootDir, "node_modules", "@img", "sharp-linux-x64")
    const libvipsDir = join(rootDir, "node_modules", "@img", "sharp-libvips-linux-x64")

    await mkdir(join(outputDir, "server"), { recursive: true })
    await writeFile(
      join(outputDir, "server", "index.ts"),
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

    await finalizeDenoDeploymentOutput({ rootDir })

    expect(existsSync(join(outputDir, "node_modules", "@img", "sharp-linux-x64", "lib/sharp-linux-x64.node"))).toBe(true)
    expect(existsSync(join(outputDir, "node_modules", "@img", "sharp-libvips-linux-x64", "lib/libvips-cpp.so.9"))).toBe(true)
    await expect(
      readFile(join(outputDir, "deno.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({ nodeModulesDir: "manual" })
    const deployRunner = await readFile(join(outputDir, "deploy.mjs"), "utf8")
    for (const text of ["DENO_DEPLOY_ORG", '["deploy", "create"', "--do-not-use-detected-build-config", "--allow-node-modules", "server/index.ts", '["deploy", ".", "--prod"', 'const common = ["--allow-node-modules", "--org", organization, "--app", app]', "mkdtemp", "finally"]) expect(deployRunner).toContain(text)
    expect(deployRunner).not.toContain("DENO_DEPLOY_NODE_MODULES_ENABLED")
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
      await writeFile(join(output, "server/index.ts"), "void 0\n", "utf8")
      await writeFile(join(output, "node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node"), "native", "utf8")
      await writeFile(join(output, "node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3"), "native", "utf8")
      await finalizeDenoDeploymentOutput({ rootDir: root })

      await execFile("git", ["init", "--quiet"], { cwd: root })
      const ignored = await execFile("git", ["check-ignore", "--no-index", ".output/server/index.ts"], { cwd: root })
      expect(ignored.stdout.trim()).toBe(".output/server/index.ts")
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
  entry: existsSync("server/index.ts"),
  sharp: existsSync("node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node"),
  libvips: existsSync("node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3"),
}) + "\\n")
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

      const invocations = (await readFile(invocationsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line) as {
        args: string[]
        cwd: string
        entry: boolean
        libvips: boolean
        sharp: boolean
      })
      expect(invocations).toHaveLength(2)
      expect(invocations[0]!.args.slice(0, 3)).toEqual(["deploy", "create", "."])
      expect(invocations[1]!.args.slice(0, 2)).toEqual(["deploy", "."])
      for (const invocation of invocations) {
        expect(relative(root, invocation.cwd).startsWith("..")).toBe(true)
        expect(invocation.args).toContain("--allow-node-modules")
        expect(invocation).toMatchObject({ entry: true, libvips: true, sharp: true })
        expect(existsSync(invocation.cwd)).toBe(false)
      }
      expect(invocations[0]!.cwd).toBe(invocations[1]!.cwd)

      await expect(execFile(process.execPath, [join(output, "deploy.mjs")], {
        env: {
          ...env,
          VITEHUB_DENO_ALWAYS_FAIL: "1",
          VITEHUB_DENO_INVOCATIONS: failedInvocationsFile,
        },
      })).rejects.toThrow()
      const failedInvocations = (await readFile(failedInvocationsFile, "utf8")).trim().split("\n")
      expect(failedInvocations).toHaveLength(2)
      const failedStages = failedInvocations.map(line => JSON.parse(line) as { args: string[], cwd: string })
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
      await writeFile(join(output, "server/index.ts"), `//#region ${sharpMarker}/lib/index.js
import { createRequire } from "node:module"
import sharp from "../node_modules/sharp/lib/index.js"

${nativeProbe}
const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: "#123456" } }).png().toBuffer()
if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) throw new Error("Sharp did not produce a PNG")
process.exit(0)
`, "utf8")
      await finalizeDenoDeploymentOutput({ outputDir: output, rootDir: workspaceRoot })

      if (process.platform === "linux" && process.arch === "x64") {
        expect(existsSync(join(output, "node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node"))).toBe(true)
        expect(existsSync(join(output, "node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3"))).toBe(true)
      }
      await execFile("deno", ["run", "-A", join(output, "server/index.ts")], { cwd: output })
    } finally {
      await rm(output, { force: true, recursive: true })
    }
  }, 30_000)
})
