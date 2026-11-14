import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { createServer } from "vite"
import { describe, expect, it, vi } from "vitest"

import { vitehub } from "vite-hub"
import { consoleTestKey } from "./support/console-signature.ts"

import type { PluginOption } from "vite"

async function postRpc(origin: string): Promise<{ body: string, status: number }> {
  const response = await fetch(`${origin}/_vitehub/rpc`, { body: "{}", headers: { accept: "application/json", "content-type": "application/json" }, method: "POST" })
  return { body: await response.text(), status: response.status }
}

describe("App Auth access routes and the Console route in vite dev", () => {
  it("keeps Auth for an app route file that takes the Console path after the server started", { timeout: 240_000 }, async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".console-auth-dispatch-"))
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    vi.stubEnv("BETTER_AUTH_SECRET", "console-auth-dispatch-dev-test-secret-0123456789")
    for (const [name, value] of Object.entries((await consoleTestKey("DEV")).env)) vi.stubEnv(name, value)
    try {
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
      await mkdir(join(root, "server/routes"), { recursive: true })
      await writeFile(join(root, "server/auth.ts"), "import { defineAuth } from \"vite-hub/auth\"\nexport default defineAuth({ access: { routes: [\"/**\"] } })\n")
      const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => PluginOption }
      server = await createServer({
        configFile: false,
        logLevel: "silent",
        root,
        plugins: [vitehub({ host: "node", publicUrl: "http://127.0.0.1", auth: true, console: true }), nitro()],
        server: { host: "127.0.0.1", port: 0, hmr: false },
      })
      await server.listen()
      const origin = new URL(server.resolvedUrls!.local[0]!).origin

      // The Console route answers an unsigned call itself: app Auth leaves the request to it.
      const consoleAnswer = await postRpc(origin)
      expect(consoleAnswer.status, consoleAnswer.body).toBe(401)
      expect(consoleAnswer.body).toContain("CONSOLE_SIGNATURE")

      // A route file added while the server runs takes POST on the same path. Auth must cover it again.
      await mkdir(join(root, "server/routes/_vitehub"), { recursive: true })
      await writeFile(join(root, "server/routes/_vitehub/rpc.post.ts"), "export default () => ({ owner: \"app\" })\n")
      const deadline = Date.now() + 60_000
      let app = await postRpc(origin)
      while (app.body.includes("CONSOLE_SIGNATURE") && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 250))
        app = await postRpc(origin)
      }
      // Nitro routed the request to the app file, and Auth answered before it.
      expect(app.body).not.toContain("CONSOLE_SIGNATURE")
      expect(app.body).not.toContain("\"owner\":\"app\"")
      expect(app.status).toBe(401)
    }
    finally {
      await server?.close()
      vi.unstubAllEnvs()
      await rm(root, { force: true, recursive: true })
    }
  })
})
