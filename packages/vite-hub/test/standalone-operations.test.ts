import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createServer } from "vite"
import { nitro } from "nitro/vite"
import { describe, expect, it } from "vitest"
import { hubKV } from "@vite-hub/kv/vite"
import { hubBlob } from "@vite-hub/blob/vite"
import { hubEmail } from "@vite-hub/email/vite"
import { hubRateLimit } from "@vite-hub/rate-limit/vite"
import { hubForms } from "@vite-hub/forms/vite"
import { findViteHubNitroDevEnvironment } from "@vite-hub/internal/dev-endpoint"
import { viteHubDevPeerHeader } from "@vite-hub/internal/dev-peer"
import { callOperationFromCli } from "@vite-hub/internal/operations"
import type { PluginOption } from "vite"

describe("standalone primitive operation transport", () => {
  it.each(["kv", "blob", "email", "rate-limit", "forms", "all", "mounted"])("runs the generated RPC in Nitro without the vitehub root integration: %s", async (selection) => {
    const root = await mkdtemp(join(import.meta.dirname, ".standalone-operations-"))
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    try {
      await writeFile(join(root, "package.json"), '{"type":"module"}\n')
      await mkdir(join(root, "server/forms"), { recursive: true })
      await writeFile(join(root, "server/forms/contact.ts"), [
        "import { defineForm } from '@vite-hub/forms'",
        "import * as v from 'valibot'",
        "export default defineForm({ schema: v.object({ message: v.string() }) })",
      ].join("\n"))
      const baseURL = selection === "mounted" ? "/portal/" : "/"
      const plugins: Record<string, unknown> = {
        kv: hubKV({ driver: "fs-lite", base: join(root, "kv") }),
        blob: hubBlob({ driver: "fs", base: join(root, "blob") }),
        email: hubEmail({ driver: "resend" }),
        "rate-limit": hubRateLimit(),
        forms: hubForms(),
      }
      const enabled = (name: string) => selection === "all" || selection === "mounted" || selection === name
      // SAFETY: The workspace resolves two Vite peer type instances; these are real Vite plugins exercised below.
      const selected = [nitro({ baseURL }), ...Object.entries(plugins).filter(([name]) => enabled(name)).map(([, plugin]) => plugin)] as unknown as PluginOption[]
      server = await createServer({
        configFile: false, root,
        plugins: selected,
        server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
      })
      await server.listen()
      const environment = findViteHubNitroDevEnvironment(server)
      expect(environment).toBeDefined()
      const url = `${new URL(server.resolvedUrls!.local[0]!).origin}${baseURL}`
      // Forms alone also proves that the plugin publishes the server for CLI discovery.
      const env = selection === "forms" ? {} : { VITEHUB_DEV_SERVER_URL: url }
      // HTTP must pass through the front dev handler so it can sign the real loopback socket.
      const call = (operation: string, input: unknown) => callOperationFromCli({
        rootDir: root, env,
      }, operation, input)
      if (enabled("kv")) {
        const written = await call("kv.set", { key: "hello", value: "from Nitro" })
        expect(written.ok, JSON.stringify(written)).toBe(true)
        expect(await call("kv.get", { key: "hello" })).toMatchObject({ ok: true, value: { value: "from Nitro" } })
      }
      if (selection === "kv") {
        for (const evidence of [undefined, "v1.forged"]) {
          const denied = await callOperationFromCli({
            rootDir: root, env,
            fetch: (url, init) => {
              const request = new Request(url, init)
              if (evidence) request.headers.set(viteHubDevPeerHeader, evidence)
              return environment!.dispatchFetch(request)
            },
          }, "kv.set", { key: "unsigned", value: "refused" })
          expect(denied).toMatchObject({ ok: false, code: "OPERATION_DEV_REQUEST", status: 403 })
        }
        const replaced = await callOperationFromCli({
          rootDir: root, env,
          fetch: (url, init) => {
            const request = new Request(url, init)
            request.headers.set(viteHubDevPeerHeader, "v1.forged")
            return fetch(request)
          },
        }, "kv.get", { key: "hello" })
        expect(replaced).toMatchObject({ ok: true, value: { value: "from Nitro" } })
      }
      if (enabled("blob")) expect(await call("blob.list", {})).toMatchObject({ ok: true })
      if (enabled("email")) expect(await call("email.outbox-list", {})).toMatchObject({ ok: true })
      if (enabled("rate-limit")) expect(await call("rate-limit.peek", { name: "missing", key: "client" })).toMatchObject({ ok: true })
      if (enabled("forms")) {
        expect(await call("forms.list", {})).toEqual({ ok: true, value: [] })
        const sent = await fetch(`${url}api/_vitehub/forms/contact`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Hello from the direct plugin" }),
        })
        expect(sent.status).toBe(201)
        const { id } = await sent.json() as { id: string }
        expect(await call("forms.get", { id })).toMatchObject({ ok: true, value: { id, status: "open", data: { message: "Hello from the direct plugin" } } })
        expect(await call("forms.mark", { id, status: "done" })).toMatchObject({ ok: true, value: { id, status: "done" } })
        expect(await call("forms.list", { status: "open" })).toEqual({ ok: true, value: [] })
        expect(await call("forms.list", { status: "done" })).toMatchObject({ ok: true, value: [{ id }] })
      }
    }
    finally {
      await server?.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 60_000)
})
