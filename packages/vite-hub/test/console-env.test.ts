import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { consoleKVKey, consoleEnvKey, consoleEnvRootKey, consoleEnvRegistryKey, consoleSectionsKey, consoleSectionsRootKey, consoleSectionsRegistryKey, installConsoleEnvScope, resolveConsoleEnv } from "../src/console/internal.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import { installConsoleEnv, manageConsoleEnv } from "../src/console/runtime/server/env.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import envHandler from "../src/console/runtime/server/env.get.ts"

// SAFETY: Console state uses the same optional symbol keys in runtime and tests.
const scope = globalThis as ConsoleInvocationScope
const symbols = [consoleKVKey, consoleEnvKey, consoleEnvRootKey, consoleEnvRegistryKey, consoleSectionsKey, consoleSectionsRootKey, consoleSectionsRegistryKey]
afterEach(() => { for (const key of symbols) { Reflect.deleteProperty(scope, key); Reflect.deleteProperty(process, key) } })

describe("Console Env", () => {
  it("loads declaration metadata without importing provider-backed Server Env", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-env-"))
    const plugin = join(root, "console.mjs")
    await writeConsoleNitroPlugin(plugin, root, ["env"], [], { agents: [], definitions: {} }, [], [])
    const generated = await readFile(plugin, "utf8")
    expect(generated).toContain('import { describeServerEnv } from "#vitehub/env/description"')
    expect(generated).not.toContain('from "#vitehub/env/server"')
  })
  it("uses registry keys distinct from KV", () => { expect(consoleEnvKey).not.toBe(consoleKVKey) })
  it("serves declaration metadata and rejects mutations", () => {
    installConsoleSections("/env-test", ["env"])
    const metadata = { entries: [{ path: "env.server.token", source: "provider" as const, provider: "vault", secret: true, required: true, hasDefault: false }] }
    installConsoleEnv("/env-test", metadata)
    expect(envHandler({ method: "GET" })).toEqual(metadata)
    expect(() => envHandler({ method: "POST" })).toThrow("Method not allowed")
  })
  it("preserves the authenticated request and keeps management out of metadata", async () => {
    installConsoleSections("/env-test", ["env"])
    const request = new Request("https://app.test/_vitehub/env/manage", { method: "POST", headers: { cookie: "session=test", origin: "https://app.test" }, body: JSON.stringify({ action: "inspect", path: "env.server.token" }) })
    let received: Request | undefined
    installConsoleEnv("/env-test", { entries: [] }, async value => { received = value; return Response.json({ ok: true }) })
    expect(envHandler({ method: "GET" })).toEqual({ entries: [] })
    expect(await (await manageConsoleEnv(request)).json()).toEqual({ ok: true })
    expect(received).toBe(request)
    expect(received?.headers.get("cookie")).toBe("session=test")
    expect(await received?.json()).toEqual({ action: "inspect", path: "env.server.token" })
    installConsoleSections("/env-test", [])
    expect((await manageConsoleEnv(request)).status).toBe(404)
  })
  it("rejects requests when Env is disabled", () => {
    installConsoleSections("/env-test", [])
    expect(() => envHandler({ method: "GET" })).toThrow("Env section not found")
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
