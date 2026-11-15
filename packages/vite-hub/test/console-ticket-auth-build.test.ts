import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { createBuilder } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { vitehub } from "vite-hub"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  return address.port
}

async function fetchWhenReady(url: string, init?: RequestInit): Promise<Response> {
  const deadline = Date.now() + 20_000
  while (true) {
    try {
      return await fetch(url, init)
    }
    catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(done => setTimeout(done, 100))
    }
  }
}

describe("One-time links in an app whose Auth protects every route", () => {
  it("leaves the ticket GET to the Console, so a link opens without an app session", { timeout: 240_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-ticket-auth-"))
    roots.push(root)
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    const files = {
      "package.json": JSON.stringify({ private: true, type: "module" }),
      "index.html": "<main>ok</main>\n",
      "server/auth.ts": "import { defineAuth } from \"vite-hub/auth\"\nexport default defineAuth({ access: { routes: [\"/**\"] }, database: \"memory\" })\n",
      "server/routes/private.get.ts": "export default () => ({ secret: true })\n",
    }
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), content)
    }
    const port = await freePort()
    const origin = `http://127.0.0.1:${port}`
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const builder = await createBuilder({
      logLevel: "silent",
      plugins: [vitehub({ host: "node", publicUrl: origin, auth: true, console: true }), nitro() as never],
      root,
    })
    await builder.buildApp()

    const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
      env: { ...process.env, BETTER_AUTH_SECRET: "ticket-auth-build-test-secret-0123456789abcdef", HOST: "127.0.0.1", NODE_ENV: "production", PORT: String(port) },
      stdio: "ignore",
    })
    try {
      // The app's Auth rule still protects the app.
      const app = await fetchWhenReady(`${origin}/private`, { headers: { accept: "application/json" } })
      expect(app.status).toBe(401)
      // The ticket GET reaches the Console, which reads the ticket. A wrong ticket gets the Console's answer, not Auth's.
      const link = await fetch(`${origin}/_vitehub/rpc?ticket=vt1_wrong`, { headers: { accept: "text/html" } })
      expect(await link.text()).toContain("CONSOLE_TICKET_INVALID")
      expect(link.status).toBe(401)
    }
    finally {
      server.kill()
    }
  })
})
