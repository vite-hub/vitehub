import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createServer } from "vite"
import { nitro } from "nitro/vite"
import { describe, expect, it } from "vitest"
import { hubKv } from "@vite-hub/kv/vite"
import { hubBlob } from "@vite-hub/blob/vite"
import { hubEmail } from "@vite-hub/email/vite"
import { hubRateLimit } from "@vite-hub/rate-limit/vite"
import { findViteHubNitroDevEnvironment } from "@vite-hub/internal/dev-endpoint"
import { callOperationFromCli } from "@vite-hub/internal/operations"
import type { PluginOption } from "vite"

describe("standalone primitive operation transport", () => {
  it.each(["kv", "blob", "email", "rate-limit", "all", "mounted"])("runs the generated RPC in Nitro without the vitehub root integration: %s", async (selection) => {
    const root = await mkdtemp(join(import.meta.dirname, ".standalone-operations-"))
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    try {
      await writeFile(join(root, "package.json"), '{"type":"module"}\n')
      const baseURL = selection === "mounted" ? "/portal/" : "/"
      const plugins = {
        kv: hubKv({ driver: "fs-lite", base: join(root, "kv") }),
        blob: hubBlob({ driver: "fs", base: join(root, "blob") }),
        email: hubEmail({ driver: "resend" }),
        "rate-limit": hubRateLimit(),
      }
      const enabled = (name: string) => selection === "all" || selection === "mounted" || selection === name
      // SAFETY: The workspace resolves two Vite peer type instances; these are real Vite plugins exercised below.
      const selected = [nitro({ baseURL }), ...Object.entries(plugins).filter(([name]) => enabled(name)).map(([, plugin]) => plugin)] as unknown as PluginOption[]
      server = await createServer({
        configFile: false, root,
        plugins: selected,
        server: { middlewareMode: true, hmr: false, watch: null },
      })
      const environment = findViteHubNitroDevEnvironment(server)
      expect(environment).toBeDefined()
      const call = (operation: string, input: unknown) => callOperationFromCli({
        rootDir: root, env: { VITEHUB_DEV_SERVER_URL: `http://localhost${baseURL}` },
        fetch: (url, init) => environment!.dispatchFetch(new Request(url, init)),
      }, operation, input)
      if (enabled("kv")) {
        const written = await call("kv.set", { key: "hello", value: "from Nitro" })
        expect(written.ok, JSON.stringify(written)).toBe(true)
        expect(await call("kv.get", { key: "hello" })).toMatchObject({ ok: true, value: { value: "from Nitro" } })
      }
      if (enabled("blob")) expect(await call("blob.list", {})).toMatchObject({ ok: true })
      if (enabled("email")) expect(await call("email.outbox-list", {})).toMatchObject({ ok: true })
      if (enabled("rate-limit")) expect(await call("rate-limit.peek", { name: "missing", key: "client" })).toMatchObject({ ok: true })
    }
    finally {
      await server?.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 60_000)
})
