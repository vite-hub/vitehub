import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { createBuilder } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { vitehub } from "vite-hub"

import { consoleTestKey } from "./support/console-signature.ts"

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

describe("Console tokens in an app whose Auth protects every route", () => {
  it("leaves the token GET of /_vitehub/site to the Console, so an impersonation or a preview opens without an app session", { timeout: 240_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-site-auth-"))
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
      env: { ...process.env, ...(await consoleTestKey("CONSOLE_SITE_BUILD")).env, BETTER_AUTH_SECRET: "site-auth-build-test-secret-0123456789abcdef", HOST: "127.0.0.1", NODE_ENV: "production", PORT: String(port) },
      stdio: "ignore",
    })
    try {
      const app = await fetchWhenReady(`${origin}/private`, { headers: { accept: "application/json" } })
      expect(app.status).toBe(401)
      const link = await fetch(`${origin}/_vitehub/site?token=vst1.wrong`, { headers: { accept: "text/html" } })
      expect(await link.text()).toContain("CONSOLE_SITE_TOKEN_REFUSED")
      expect(link.status).toBe(401)
      const visit = await fetch(`${origin}/_vitehub/site?${new URLSearchParams({ return: "/", intent: "A".repeat(43) })}`, { redirect: "manual" })
      expect(visit.status).toBe(303)
      expect(visit.headers.get("set-cookie")).toContain(`__Host-vitehub-site-state-${"A".repeat(43)}=`)
    }
    finally {
      server.kill()
    }
  })
})
