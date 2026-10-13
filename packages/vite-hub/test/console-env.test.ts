import { ref } from "vue"
import { indexEnvStatuses } from "../src/console/runtime/client/env-status.ts"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { consoleKVKey, consoleEnvKey, consoleEnvRootKey, consoleEnvRegistryKey, consoleSectionsKey, consoleSectionsRootKey, consoleSectionsRegistryKey, installConsoleEnvScope, resolveConsoleEnv } from "../src/console/internal.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import { installConsoleEnv, manageConsoleEnv } from "../src/console/runtime/server/env.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import envHandlerRoute from "../src/console/runtime/server/env.get.ts"
import { allowed } from "./support/console-access.ts"

const envHandler = allowed(envHandlerRoute)

// SAFETY: Console state uses the same optional symbol keys in runtime and tests.
const scope = globalThis as ConsoleInvocationScope
const symbols = [consoleKVKey, consoleEnvKey, consoleEnvRootKey, consoleEnvRegistryKey, consoleSectionsKey, consoleSectionsRootKey, consoleSectionsRegistryKey]
afterEach(() => { for (const key of symbols) { Reflect.deleteProperty(scope, key); Reflect.deleteProperty(process, key) } })

describe("Console Env", () => {
  it("loads declaration metadata without importing provider-backed Server Env", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-env-"))
    const plugin = join(root, "console.mjs")
    await writeConsoleNitroPlugin(plugin, root, ["env"], [], { agents: [], content: {} }, [], [])
    const generated = await readFile(plugin, "utf8")
    expect(generated).toContain('import { describeServerEnv } from "#vitehub/env/description"')
    expect(generated).not.toContain('from "#vitehub/env/server"')
    // Status inspection can call providers, so the plugin imports it only on request.
    expect(generated).toContain('async event => (await import("#vitehub/env/server")).inspectServerEnv(event)')
  })
  it("retains distinct pathless statuses through reactive row filtering", () => {
    const descriptions = ref([
      { source: "env" as const, secret: true, required: true, hasDefault: false },
      { path: "env.server.public", source: "literal" as const, secret: false, required: false, hasDefault: false },
      { source: "provider" as const, secret: true, required: false, hasDefault: false },
    ])
    const statuses = ref(indexEnvStatuses(descriptions.value, [
      { blocking: true, status: "missing" },
      { blocking: false, path: "env.server.public", status: "available" },
      { blocking: false, status: "error" },
    ]))
    const filtered = descriptions.value.filter(entry => !entry.path)
    expect(filtered.map(entry => statuses.value.get(entry))).toEqual([{ blocking: true, status: "missing" }, { blocking: false, status: "error" }])
  })

  it("uses registry keys distinct from KV", () => { expect(consoleEnvKey).not.toBe(consoleKVKey) })
  it("serves declaration metadata and rejects mutations", async () => {
    installConsoleSections("/env-test", ["env"])
    const metadata = { entries: [{ path: "env.server.token", source: "provider" as const, provider: "vault", secret: true, required: true, hasDefault: false, type: "string" }, { path: "env.server.dryRun", source: "env" as const, secret: false, required: true, hasDefault: true, type: "boolean" }] }
    installConsoleEnv("/env-test", metadata)
    await expect(envHandler({ method: "GET" })).resolves.toEqual(metadata)
    await expect(envHandler({ method: "POST" })).rejects.toThrow("Method not allowed")
  })
  it("loads status only on request and never returns values", async () => {
    installConsoleSections("/env-test", ["env"])
    const metadata = { entries: [
      { path: "env.server.token", source: "provider" as const, provider: "vault", secret: true, required: true, hasDefault: false },
      { path: "env.server.label", source: "env" as const, secret: false, required: false, hasDefault: false },
      { source: "provider" as const, provider: "vault", secret: true, required: true, hasDefault: false },
    ] }
    const inspect = vi.fn(async () => ({ entries: [
      { masked: true, path: "env.server.token", provider: "vault", required: true, source: "provider" as const, status: "error" as const },
      { masked: false, path: "env.server.label", required: false, source: "env" as const, status: "missing" as const },
      { masked: true, provider: "vault", required: true, source: "provider" as const, status: "missing" as const },
    ] }))
    installConsoleEnv("/env-test", metadata, undefined, inspect)
    await expect(envHandler({ method: "GET" })).resolves.toEqual(metadata)
    expect(inspect).not.toHaveBeenCalled()
    await expect(envHandler({ method: "GET", req: { url: "/api/_vitehub/console/env?status=1" } })).resolves.toEqual({
      ...metadata,
      status: [
        { blocking: true, path: "env.server.token", status: "error" },
        { blocking: false, path: "env.server.label", status: "missing" },
        { blocking: true, status: "missing" },
      ],
    })
    expect(inspect).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ method: "GET" }))
  })
  it("hides status failures behind a fixed message", async () => {
    installConsoleSections("/env-test", ["env"])
    const statusEvent = { method: "GET", req: { url: "/api/_vitehub/console/env?status=1" } }
    installConsoleEnv("/env-test", { entries: [] })
    await expect(envHandler(statusEvent)).rejects.toMatchObject({ statusCode: 503, statusMessage: "Env status is unavailable." })
    installConsoleEnv("/env-test", { entries: [] }, undefined, async () => { throw new Error("private provider detail") })
    await expect(envHandler(statusEvent)).rejects.toMatchObject({ statusCode: 503, statusMessage: "Env status is unavailable." })
  })
  it("preserves the authenticated request and keeps management out of metadata", async () => {
    installConsoleSections("/env-test", ["env"])
    const request = new Request("https://app.test/_vitehub/env/manage", { method: "POST", headers: { cookie: "session=test", origin: "https://app.test" }, body: JSON.stringify({ action: "inspect", path: "env.server.token" }) })
    let received: Request | undefined
    installConsoleEnv("/env-test", { entries: [] }, async value => { received = value; return Response.json({ ok: true }) })
    await expect(envHandler({ method: "GET" })).resolves.toEqual({ entries: [] })
    expect(await (await manageConsoleEnv(request)).json()).toEqual({ ok: true })
    expect(received).toBe(request)
    expect(received?.headers.get("cookie")).toBe("session=test")
    expect(await received?.json()).toEqual({ action: "inspect", path: "env.server.token" })
    installConsoleSections("/env-test", [])
    expect((await manageConsoleEnv(request)).status).toBe(404)
  })
  it("rejects requests when Env is disabled", async () => {
    installConsoleSections("/env-test", [])
    await expect(envHandler({ method: "GET" })).rejects.toThrow("Env section not found")
  })
  it("isolates project inventories across shared process state", () => {
    const processState = {}
    const first: ConsoleInvocationScope = { process: processState }
    const second: ConsoleInvocationScope = { process: processState }
    const a = { entries: [] }
    const b = { entries: [{ path: "env.server.other", source: "env" as const, secret: true, required: true, hasDefault: false }] }
    installConsoleEnvScope("/first", a, first)
    installConsoleEnvScope("/second", b, second)
    expect(resolveConsoleEnv(first)).toBe(a)
    expect(resolveConsoleEnv(second)).toBe(b)
    expect(resolveConsoleEnv({ process: processState })).toBeUndefined()
  })
})
