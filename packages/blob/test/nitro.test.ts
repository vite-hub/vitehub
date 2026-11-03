import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { build, createNitro, prepare } from "nitropack/core"
import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)

it("builds packed Blob imports with one shared named-store runtime in Nitro", async () => {
  const workspaceRoot = resolve(import.meta.dirname, "../../..")
  const tempDir = join(workspaceRoot, ".cache/blob-nitro")
  await mkdir(tempDir, { recursive: true })
  const root = await mkdtemp(join(tempDir, "consumer-"))
  const packageRoot = join(root, "node_modules/@vite-hub/blob")
  let nitro: Awaited<ReturnType<typeof createNitro>> | undefined

  try {
    // A real node_modules directory exercises Nitro's package externalization.
    await mkdir(packageRoot, { recursive: true })
    await cp(resolve(import.meta.dirname, "../dist"), join(packageRoot, "dist"), { recursive: true })
    await cp(resolve(import.meta.dirname, "../package.json"), join(packageRoot, "package.json"))
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      const dependency = await realpath(resolve(import.meta.dirname, "../node_modules", name)).catch(() => undefined)
      if (!dependency) continue
      const target = join(root, "node_modules", name)
      await mkdir(dirname(target), { recursive: true })
      await symlink(dependency, target, "dir")
    }
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }))
    await mkdir(join(root, "server/api"), { recursive: true })
    await writeFile(join(root, "server/api/blob.ts"), [
      'import { blob } from "@vite-hub/blob"',
      "export default defineEventHandler(async () => {",
      '  const store = blob.store("uploads")',
      '  const [writeError] = await store.put("proof.txt", "packed Nitro Blob", { contentType: "text/plain" })',
      "  if (writeError) throw writeError",
      '  const [readError, value] = await store.get("proof.txt")',
      "  if (readError) throw readError",
      "  return value.text()",
      "})",
    ].join("\n"))

    const { hubBlob } = await import(pathToFileURL(join(packageRoot, "dist/vite.js")).href) as typeof import("../src/vite.ts")
    const plugin = hubBlob({ stores: {
      default: { driver: "fs", base: join(root, "default") },
      uploads: { driver: "fs", base: join(root, "uploads") },
    } })
    const inline = ["existing-inline"]
    const external = ["existing-external"]
    const config = { root, build: { outDir: "dist" }, nitro: { externals: { inline, external } } }
    ;((typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as (config: unknown, env: unknown) => void)(config, { command: "build" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)(config)

    expect(config.nitro.externals.external).toEqual(external)
    expect(inline).toEqual(["existing-inline"])

    nitro = await createNitro({
      ...config.nitro,
      dev: false,
      rootDir: root,
      srcDir: join(root, "server"),
      preset: "node-listener",
      nodeModulesDirs: [join(root, "node_modules"), join(workspaceRoot, "node_modules")],
    })
    await prepare(nitro)
    await build(nitro)
    expect(config.nitro.externals.inline.filter(entry => entry === "@vite-hub/blob")).toHaveLength(1)

    // Nitro installs process handlers and globals, so run its output in a child.
    await execFileAsync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict"
      import { createServer } from "node:http"
      import { listener } from "./.output/server/index.mjs"
      const server = createServer(listener)
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, "127.0.0.1", resolve)
        })
        const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/blob", {
          signal: AbortSignal.timeout(5000),
        })
        assert.equal(response.status, 200, await response.clone().text())
        assert.equal(await response.text(), "packed Nitro Blob")
      }
      catch (error) {
        console.error(error)
        process.exitCode = 1
      }
      finally {
        server.closeAllConnections()
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    `], { cwd: root, timeout: 10_000 })
    expect(await readFile(join(root, "uploads/proof.txt"), "utf8")).toBe("packed Nitro Blob")
  }
  finally {
    try {
      await nitro?.close()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}, 60_000)
