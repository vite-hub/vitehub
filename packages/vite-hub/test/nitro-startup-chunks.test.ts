import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { createBuilder } from "vite"
import { expect, it } from "vitest"

import { vitehub } from "vite-hub"

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  return address.port
}

/** Reads every module that `file` imports statically, as Node does when the server starts. */
async function startupSource(file: string, seen = new Set<string>()): Promise<string> {
  if (seen.has(file)) return ""
  seen.add(file)
  const source = await readFile(file, "utf8")
  const imports = [...source.matchAll(/^(?:import|export)\b[^;"']*?["'](\.{1,2}\/[^"']+)["']/gm)].map(match => match[1]!)
  const nested = await Promise.all(imports.map(path => startupSource(resolve(dirname(file), path), seen)))
  return source + nested.join("")
}

it("keeps a package that loads on demand out of the startup chunks when it shares a dependency with startup code", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-startup-chunks-"))
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, "index.html"), "<main>ok</main>\n")
    // Nitro names chunks after the `node_modules` package in the module path.
    const vendor = join(root, "vendor/node_modules")
    await mkdir(join(vendor, "shared"), { recursive: true })
    await mkdir(join(vendor, "@adapter/lazy"), { recursive: true })
    await writeFile(join(vendor, "shared/index.js"), "export const shared = \"shared\"\n")
    await writeFile(join(vendor, "@adapter/lazy/index.js"), "import { shared } from \"../../shared/index.js\"\nexport const lazy = `LAZY_ONLY:${shared}`\n")
    await mkdir(join(root, "server/plugins"), { recursive: true })
    await mkdir(join(root, "server/routes"), { recursive: true })
    await writeFile(join(root, "server/plugins/shared.ts"), "import { shared } from \"../../vendor/node_modules/shared/index.js\"\nexport default () => { globalThis.sharedAtStartup = shared }\n")
    await writeFile(join(root, "server/routes/lazy.ts"), "export default async () => (await import(\"../../vendor/node_modules/@adapter/lazy/index.js\")).lazy\n")

    const builder = await createBuilder({ logLevel: "silent", plugins: [vitehub({ preset: "node" })], root })
    await builder.buildApp()

    const entry = join(root, ".output/server/index.mjs")
    const startup = await startupSource(entry)
    expect(startup).toContain("\"shared\"")
    expect(startup).not.toContain("LAZY_ONLY")

    const port = await freePort()
    const server = spawn(process.execPath, [entry], {
      env: { ...process.env, HOST: "127.0.0.1", NODE_ENV: "production", PORT: String(port) },
      stdio: "ignore",
    })
    try {
      const deadline = Date.now() + 20_000
      let response: Response | undefined
      while (!response) {
        response = await fetch(`http://127.0.0.1:${port}/lazy`).catch(async (error: unknown) => {
          if (Date.now() > deadline) throw error
          await new Promise(done => setTimeout(done, 100))
          return undefined
        })
      }
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("LAZY_ONLY:shared")
    }
    finally {
      server.kill()
    }
  }
  finally {
    await rm(root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 180_000)
