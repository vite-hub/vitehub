import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const tempDirs: string[] = []

async function createConsumerRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-kv-vite-"))
  tempDirs.push(rootDir)

  await mkdir(join(rootDir, "node_modules", "@vite-hub"), { recursive: true })
  await symlink(resolve(import.meta.dirname, ".."), join(rootDir, "node_modules", "@vite-hub", "kv"), "dir")
  await mkdir(join(rootDir, "src"), { recursive: true })
  await writeFile(join(rootDir, "package.json"), JSON.stringify({
    name: "vitehub-kv-vite-fixture",
    private: true,
    type: "module",
  }, null, 2))
  await writeFile(join(rootDir, "src", "worker.ts"), [
    `import { kv } from "@vite-hub/kv"`,
    ``,
    `export default {`,
    `  async fetch() {`,
    `    await kv.set("settings", { ok: true })`,
    `    return Response.json(await kv.get("settings"))`,
    `  },`,
    `}`,
    ``,
  ].join("\n"))

  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function readOutput(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
  return (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n")
}

describe("KV Vite output", () => {
  it("bundles selected runtime config into server output", async () => {
    const rootDir = await createConsumerRoot()
    const entry = join(rootDir, "src", "worker.ts")
    const [{ build }, { hubKv }] = await Promise.all([
      import("vite"),
      import("../src/vite.ts"),
    ])

    await build({
      appType: "custom",
      build: {
        outDir: "dist",
        rollupOptions: {
          input: entry,
          output: { entryFileNames: "worker.js" },
        },
        ssr: entry,
      },
      configFile: false,
      kv: {
        binding: "KV_CUSTOM",
        driver: "cloudflare-kv-binding",
        namespaceId: "namespace-id",
      },
      logLevel: "silent",
      plugins: [hubKv()],
      root: rootDir,
    })

    const output = await readOutput(join(rootDir, "dist"))

    expect(output).not.toContain(`from "@vite-hub/kv"`)
    expect(output).not.toContain("#vitehub/kv/config")
    expect(output).not.toContain("@upstash/redis")
    expect(output).toContain("cloudflare-kv-binding")
    expect(output).toContain("KV_CUSTOM")
  })
})
