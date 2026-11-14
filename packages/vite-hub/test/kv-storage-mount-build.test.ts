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
  if (!address || typeof address === "string") throw new Error("No port")
  return address.port
}

// The route uses `useStorage()` as a third-party Nuxt module does, and `kv` to check that both see the same store.
const probeRoute = `
import { useStorage } from "nitro/storage"
import { kv } from "vite-hub/kv"

export default async () => {
  const mount = useStorage("kv")
  const sessions = useStorage("kv-sessions")
  await kv.set("from-kv", { source: "kv" })
  await mount.setItem("from-mount", { source: "mount" })
  await sessions.setItem("token", "abc")
  const viaMount = await mount.getItem("from-kv")
  const [, viaKV] = await kv.get("from-mount")
  const [, sessionViaKV] = await kv.store("sessions").get("token")
  const keys = (await mount.getKeys()).sort()
  await sessions.clear()
  const [, defaultAfterClear] = await kv.get("from-kv")
  const sessionKeysAfterClear = await sessions.getKeys()
  return { viaMount, viaKV, sessionViaKV, keys, defaultAfterClear, sessionKeysAfterClear }
}
`

async function buildAndRun(): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-kv-storage-mount-"))
  roots.push(root)
  await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
  const files = {
    "package.json": JSON.stringify({ private: true, type: "module" }),
    "index.html": "<main>ok</main>\n",
    "server/routes/probe.ts": probeRoute,
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
  const stores = { default: { driver: "fs-lite" as const }, sessions: { driver: "fs-lite" as const, base: ".vitehub/data/kv-sessions" } }
  const builder = await createBuilder({
    logLevel: "silent",
    plugins: [vitehub({ host: "node", kv: { stores } }), nitro() as never],
    root,
  })
  await builder.buildApp()

  const port = await freePort()
  const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], { cwd: root, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: "pipe" })
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`http://127.0.0.1:${port}/probe`).catch(() => undefined)
      if (response) return await response.json()
      await new Promise(done => setTimeout(done, 100))
    }
    throw new Error("The server did not start")
  }
  finally {
    server.kill()
  }
}

describe("KV as a Nitro storage mount", () => {
  it("mounts the default store at `kv` and named stores at `kv-<name>`", { timeout: 240_000 }, async () => {
    await expect(buildAndRun()).resolves.toEqual({
      viaMount: { source: "kv" },
      viaKV: { source: "mount" },
      sessionViaKV: "abc",
      keys: ["from-kv", "from-mount"],
      defaultAfterClear: { source: "kv" },
      sessionKeysAfterClear: [],
    })
  })
})
