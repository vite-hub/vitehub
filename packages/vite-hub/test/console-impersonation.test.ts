import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAuthConsole } from "../../auth/src/console-runtime.ts"
import { consoleEventsFixture } from "../../auth/test/fixtures/console-events.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import authManage from "../src/console/runtime/server/auth-manage.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { assertConsoleAccess, resolveConsoleAccessBuild, resolveConsoleOptions } from "../src/console/vite.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const state = vi.hoisted(() => ({ inspect: undefined as unknown, host: undefined as unknown }))
vi.mock("@vite-hub/auth/server", async importOriginal => ({
  ...(await importOriginal<typeof import("@vite-hub/auth/server")>()),
  getAuthConsoleForRequest: (_request: Request, _event: unknown, host: unknown) => {
    state.host = host
    return state.inspect
  },
}))
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  state.inspect = undefined
  state.host = undefined
})

/** Merge the cookies that a response sets into a Cookie header, as a browser does. */
function jar(cookie: string, response: Response): string {
  const values = new Map(cookie.split("; ").filter(Boolean).map(pair => [pair.slice(0, pair.indexOf("=")), pair] as const))
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0]!
    const name = pair.slice(0, pair.indexOf("="))
    if (/max-age=0/i.test(header) || pair.endsWith("=")) values.delete(name)
    else values.set(name, pair)
  }
  return [...values.values()].join("; ")
}

function manage(body: unknown, cookie = "") {
  return authManage.fetch(new Request("http://localhost:5173/_vitehub/auth/manage", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-vitehub-console": "1", origin: "http://localhost:5173", cookie },
  }))
}

/** One `auth.*` operation through the Console RPC, with the cookies of the browser. */
async function operation(name: string, input: Record<string, unknown> = {}, cookie = "") {
  return await handleConsoleRpcRequest(new Request("http://localhost:5173/_vitehub/rpc", {
    method: "POST",
    body: operationRpcBody(name, input),
    headers: { "content-type": "application/json", "x-vitehub-console": "1", origin: "http://localhost:5173", cookie },
  }))
}

describe("console.impersonation configuration", () => {
  it("accepts only a boolean, needs app Auth, and reaches the generated access policy", async () => {
    expect(resolveConsoleOptions({ impersonation: true })).toMatchObject({ impersonation: true })
    expect(() => resolveConsoleOptions({ impersonation: "yes" })).toThrow("console.impersonation must be true or false")
    expect(() => installConsoleAccess({ mode: "open", impersonation: "yes" as unknown as boolean })).toThrow("console.impersonation must be true or false")
    expect(() => assertConsoleAccess({ auth: false, impersonation: true }, {})).toThrow("console.impersonation needs app Auth")

    const root = await mkdtemp(join(tmpdir(), "vitehub-console-impersonation-"))
    try {
      expect(resolveConsoleAccessBuild({ auth: false, impersonation: true }, { root })).toMatchObject({ mode: "open", impersonation: true })
      expect(resolveConsoleAccessBuild({}, { root })).toEqual({ mode: "token" })
      const file = join(root, "console.mjs")
      await writeConsoleNitroPlugin({ file, projectRoot: root, sections: [], catalog: { agents: [], content: {} }, blobStores: [], access: { mode: "token", impersonation: true } })
      expect(await readFile(file, "utf8")).toContain('installConsoleAccess({ mode: "token", impersonation: true })')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("Auth Console impersonation route", () => {
  it("rejects start and stop when console.impersonation is off", async () => {
    const inspect = { describe: vi.fn(), execute: vi.fn(), stopImpersonating: vi.fn() }
    state.inspect = inspect
    installConsoleSections("impersonation-off", ["auth"])
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["auth"] }) })
    for (const body of [{ action: "impersonate", userId: "user-1" }, { action: "stopImpersonating" }]) {
      const response = await manage(body)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ message: expect.stringContaining("console.impersonation") })
    }
    // The route refuses before it opens the Auth Console.
    expect(state.host).toBeUndefined()
    expect(inspect.execute).not.toHaveBeenCalled()
    expect(inspect.stopImpersonating).not.toHaveBeenCalled()
  })

  it("lets a read-only Auth grant list users but not change them", async () => {
    const inspect = { users: vi.fn(async () => [undefined, { items: [], total: 0, offset: 0, limit: 25 }]), execute: vi.fn() }
    state.inspect = inspect
    installConsoleSections("impersonation-read-only", ["auth"])
    installConsoleAccess({ mode: "open", impersonation: true, authorize: () => ({ sections: ["auth:read"] }) })
    expect((await operation("auth.users")).status).toBe(200)
    const impersonate = await manage({ action: "impersonate", userId: "user-1" })
    expect(impersonate.status).toBe(403)
    expect(await impersonate.json()).toEqual({ message: "This Console access can read Auth data but not change it." })
    const ban = await operation("auth.ban", { userId: "user-1" })
    expect(ban.status).toBe(403)
    expect(await operationRpcResponseResult(ban)).toMatchObject({ code: "CONSOLE_ACCESS_DENIED", message: expect.stringContaining("read-only") })
    expect(inspect.execute).not.toHaveBeenCalled()
  })

  it("starts and stops impersonation, restores the admin session, and records both events", async () => {
    const app = await consoleEventsFixture()
    closers.push(() => app.database.sqlite.close())
    state.inspect = createAuthConsole(app.auth, {}, app.store, { impersonation: true })
    installConsoleSections("impersonation-route", ["auth"])
    installConsoleAccess({ mode: "open", impersonation: true, authorize: () => ({ sections: ["auth"] }) })

    const described = await operationRpcResponseResult(await operation("auth.describe", {}, app.operator.cookie))
    expect(state.host).toEqual({ impersonation: true })
    expect(described).toMatchObject({ value: { actions: { impersonate: { enabled: true } }, impersonation: { duration: 3600, active: null } } })
    expect(await operationRpcResponseResult(await operation("auth.user", { id: app.member.id }, app.operator.cookie))).toMatchObject({ value: { impersonation: { enabled: true } } })

    const started = await manage({ action: "impersonate", userId: app.member.id }, app.operator.cookie)
    expect(started.status).toBe(200)
    const impersonating = jar(app.operator.cookie, started)
    const session = (cookie: string) => app.auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } })
    expect(await session(impersonating)).toMatchObject({ user: { id: app.member.id }, session: { impersonatedBy: app.operator.id } })
    expect(await operationRpcResponseResult(await operation("auth.describe", {}, impersonating))).toMatchObject({
      value: { impersonation: { active: { user: { id: app.member.id, name: "Ada Lovelace" } } } },
    })

    const stopped = await manage({ action: "stopImpersonating" }, impersonating)
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toEqual({ action: "stopImpersonating", ok: true })
    expect(await session(jar(impersonating, stopped))).toMatchObject({ user: { id: app.operator.id } })
    for (const type of ["impersonation.started", "impersonation.stopped"] as const)
      expect((await app.store.list({ type })).events, type).toEqual([expect.objectContaining({ actor: `user:${app.operator.id}`, userId: app.member.id })])
  })
})
