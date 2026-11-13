import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createBuilder } from "vite"
import { expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { consoleTestKey } from "./support/console-signature.ts"

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  return address.port
}

// The Console turns on Comments, and Comments adds the default Database, so this app bundles the Comments schema,
// drizzle-orm, and @libsql/client in chunks that import each other at startup.
it("starts a KV app with the Console from the Node output", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-node-start-"))
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await mkdir(join(root, "server/api"), { recursive: true })
    await writeFile(join(root, "server/api/health.get.ts"), "import { defineEventHandler } from \"h3\"\n\nexport default defineEventHandler(() => ({ ok: true }))\n")

    const ci = await consoleTestKey("CI")
    const builder = await createBuilder({ logLevel: "silent", plugins: [vitehub({ console: true, kv: true, host: "node" })], root })
    await builder.buildApp()

    const port = await freePort()
    const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
      cwd: root,
      env: { ...process.env, HOST: "127.0.0.1", NODE_ENV: "production", PORT: String(port), ...ci.env },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    server.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    const exited = new Promise<void>(done => server.once("exit", () => done()))
    try {
      const deadline = Date.now() + 20_000
      let response: Response | undefined
      while (!response) {
        if (server.exitCode !== null) break
        response = await fetch(`http://127.0.0.1:${port}/api/health`).catch(async (error: unknown) => {
          if (Date.now() > deadline) throw error
          await new Promise(done => setTimeout(done, 100))
          return undefined
        })
      }
      expect(stderr).not.toContain("TypeError")
      expect(response?.status).toBe(200)
      expect(await response?.json()).toEqual({ ok: true })
      // The built server refuses an unsigned call. plugin-order-build.test.ts checks a signed call on a Node build.
      const unsigned = await fetch(`http://127.0.0.1:${port}/_vitehub/rpc`, { body: "{}", headers: { "content-type": "application/json", "x-vitehub-console": "1" }, method: "POST" })
      expect(unsigned.status).toBe(401)
      // Apps serve no Console page, Schedule run route, or Auth management route.
      for (const path of ["/_vitehub/schedules/run", "/_vitehub/auth/manage"]) {
        const post = await fetch(`http://127.0.0.1:${port}${path}`, { body: "{}", headers: { "content-type": "application/json" }, method: "POST" })
        expect(post.status, path).toBe(404)
      }
      expect(stderr).not.toContain("Unhandled error")
    }
    finally {
      server.kill()
      await exited
    }
  }
  finally {
    await rm(root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 180_000)
