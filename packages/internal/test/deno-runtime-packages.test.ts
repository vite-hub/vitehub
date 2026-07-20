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
        'import sharp from "sharp"; import("@scope/tool/subpath"); import "node:path"; import "cloudflare:workers"\n//#region node_modules/.pnpm/native-addon@1.0.0/node_modules/native-addon/index.js\n/** @example const got = require("got") */',
      ),
    ).toEqual(["@scope/tool", "native-addon", "sharp"])
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

    expect(existsSync(join(outputDir, "node_modules", "sharp", "package.json"))).toBe(true)
    expect(
      existsSync(join(outputDir, "node_modules", "@img", "sharp-linux-x64", "package.json")),
    ).toBe(true)
    await expect(
      readFile(join(outputDir, "deno.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({ nodeModulesDir: "manual" })
    const deployRunner = await readFile(join(outputDir, "deploy.mjs"), "utf8")
    expect(deployRunner).toContain("DENO_DEPLOY_ORG")
    expect(deployRunner).toContain('["deploy", "create"')
    expect(deployRunner).toContain("--do-not-use-detected-build-config")
    expect(deployRunner).toContain("server/index.ts")
    expect(deployRunner).toContain('const common = ["--org", organization, "--app", app]')
    expect(deployRunner).toContain('"--region", region, "--allow-node-modules", ...common')
  })
})
