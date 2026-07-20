import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  collectDenoRuntimePackageNames,
  finalizeDenoDeploymentOutput,
} from "../src/build/deno-runtime-packages.ts"

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value), "utf8")
}

describe("Deno deployment output", () => {
  it("finds external packages without treating runtime protocols as npm packages", () => {
    expect(
      collectDenoRuntimePackageNames(
        'import sharp from "sharp"; const tool = ready ? await import("@scope/tool/subpath") : undefined; module.exports = require("native-addon"); import "node:path"; import "cloudflare:workers"\n//#region node_modules/.pnpm/native-addon@1.0.0/node_modules/native-addon/index.js\n/** @example const got = require("got") */',
      ),
    ).toEqual(["@scope/tool", "native-addon", "sharp"])
  })

  it("ignores import comments", () => {
    expect(collectDenoRuntimePackageNames('// import("fake")\nimport "real"')).toEqual(["real"])
  })

  it("stages reachable packages and their installed optional native dependencies", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-deno-output-"))
    const outputDir = join(rootDir, ".output")
    const sharpDir = join(rootDir, "node_modules", "sharp")
    const nativeDir = join(rootDir, "node_modules", "@img", "sharp-linux-x64")

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
      optionalDependencies: { "@img/sharp-linux-x64": "9.9.9" },
    })
    await writeFile(join(sharpDir, "index.js"), "export default {}\n", "utf8")
    await writeJson(join(nativeDir, "package.json"), {
      name: "@img/sharp-linux-x64",
      version: "9.9.9",
      main: "index.js",
    })
    await writeFile(join(nativeDir, "index.js"), "export default {}\n", "utf8")

    await finalizeDenoDeploymentOutput({ rootDir })

    expect(existsSync(join(outputDir, "node_modules", "sharp", "node_modules", "@img", "sharp-linux-x64", "package.json"))).toBe(true)
    await expect(
      readFile(join(outputDir, "deno.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({ nodeModulesDir: "manual" })
    const deployRunner = await readFile(join(outputDir, "deploy.mjs"), "utf8")
    for (const text of ["DENO_DEPLOY_ORG", '["deploy", "create"', "--do-not-use-detected-build-config", "server/index.ts", '["deploy", ".", "--prod"', 'const common = ["--org", organization, "--app", app]', '"--region", region, "--allow-node-modules", ...common']) expect(deployRunner).toContain(text)
  })

  it("uses the pnpm package from a bundle marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deno-pnpm-"))
    const bundled = join(root, "node_modules/.pnpm/sharp@2/node_modules/sharp/package.json")
    await writeJson(join(root, "package.json"), {})
    await writeJson(join(root, "node_modules/sharp/package.json"), { name: "sharp", version: "1" })
    await writeJson(bundled, { name: "sharp", version: "2", optionalDependencies: { native: "2" } })
    await writeJson(join(dirname(bundled), "node_modules/native/package.json"), { name: "native", version: "2" })
    await mkdir(join(root, ".output/server"), { recursive: true })
    await writeFile(join(root, ".output/server/index.ts"), "//#region node_modules/.pnpm/sharp@2/node_modules/sharp/index.js\n")
    await finalizeDenoDeploymentOutput({ rootDir: root })
    await expect(readFile(join(root, ".output/node_modules/sharp/package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ version: "2" })
  })
})
