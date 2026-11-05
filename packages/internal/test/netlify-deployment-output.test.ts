import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-netlify-output-"))
  tempDirs.push(rootDir)
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Netlify provider deployment output", () => {
  it.each([
    { conditions: undefined, expected: "netlify" },
    { conditions: ["node"], expected: "node" },
  ])("resolves provider exports and preserves explicit conditions: $expected", async ({ conditions, expected }) => {
    const rootDir = await createTempProject()
    const dependencyDir = join(rootDir, "node_modules", "provider-client")
    await mkdir(dependencyDir, { recursive: true })
    await writeFile(join(dependencyDir, "package.json"), JSON.stringify({
      name: "provider-client",
      type: "module",
      exports: { netlify: "./netlify.mjs", node: "./node.mjs" },
    }))
    for (const provider of ["netlify", "node"]) {
      await writeFile(join(dependencyDir, `${provider}.mjs`), `export default ${JSON.stringify(provider)}`)
    }
    const entry = join(rootDir, "entry.mjs")
    await writeFile(entry, 'export { default } from "provider-client"')
    const { writeProviderDeploymentOutputs } = await import("../src/build/deployment-output.ts")
    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      netlify: { functions: [{
        bundleEntry: entry,
        bundleOptions: { conditions, format: "esm", platform: "node" },
        functionName: "provider-exports",
      }] },
      rootDir,
    })
    const outfile = join(rootDir, ".netlify", "v1", "functions", "provider-exports.mjs")
    const loaded: { default: string } = await import(pathToFileURL(outfile).href)
    expect(loaded.default).toBe(expected)
  })

  it("preserves literal static config when bundled code declares config", async () => {
    const rootDir = await createTempProject()
    const entry = join(rootDir, "entry.mjs")
    await writeFile(entry, [
      "function config(newConfig) {",
      "  return newConfig",
      "}",
      "export default async function handler() {",
      "  return new Response(config(\"ok\"))",
      "}",
      "",
    ].join("\n"), "utf8")

    const { writeProviderDeploymentOutputs } = await import("../src/build/deployment-output.ts")
    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      netlify: {
        functions: [{
          bundleEntry: entry,
          bundleOptions: { format: "esm", platform: "node" },
          config: {
            name: "vitehub-agent",
            nodeBundler: "esbuild",
            path: "/api/test",
          },
          functionName: "vitehub-agent",
        }],
      },
      rootDir,
    })

    const outfile = join(rootDir, ".netlify", "v1", "functions", "vitehub-agent.mjs")
    const generated = await readFile(outfile, "utf8")
    expect(generated).toContain("export const config = {")
    expect(generated).toContain("\"path\": \"/api/test\"")
    expect(generated).not.toContain("function config(")

    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as {
      config: { name: string, nodeBundler: string, path: string }
      default: () => Promise<Response>
    }
    expect(loaded.config).toEqual({
      name: "vitehub-agent",
      nodeBundler: "esbuild",
      path: "/api/test",
    })
    expect(typeof loaded.default).toBe("function")
    expect(loaded.default.name).toBe("handler")
    await expect((await loaded.default()).text()).resolves.toBe("ok")
  })
})
