import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { createProject, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

const consoleUrl = "https://console.example.com"
const token = `vhk_${"S".repeat(43)}`

function fakeConsole(options: { deny?: boolean, pending?: number } = {}) {
  const requests: { method: string, path: string, authorization: string | null, body: unknown }[] = []
  let pending = options.pending ?? 1
  let revoked = false
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ authorization: headers.get("authorization"), body, method: init?.method ?? "GET", path: url.pathname })
    if (url.origin !== consoleUrl) throw new Error(`unexpected request to ${url.origin}`)
    if (url.pathname === "/api/auth/device/code") {
      return Response.json({ device_code: "device-1", expires_in: 900, interval: 0, user_code: "WDJBMJHT", verification_uri: `${consoleUrl}/device`, verification_uri_complete: `${consoleUrl}/device?user_code=WDJBMJHT` })
    }
    if (url.pathname === "/api/auth/cli/token") {
      if (options.deny) return Response.json({ error: "access_denied" }, { status: 400 })
      if (pending-- > 0) return Response.json({ error: "authorization_pending" }, { status: 400 })
      return Response.json({ access_token: token, expires_in: 90 * 86_400, key_id: "key-1", scope: "", team: { id: "t1", name: "Ada's team" }, token_type: "Bearer", user: { email: "ada@example.com", id: "u1", name: "Ada" } })
    }
    if (url.pathname === "/api/whoami") {
      if (revoked || headers.get("authorization") !== `Bearer ${token}`) return Response.json({ code: "CONSOLE_API_KEY_INVALID" }, { status: 401 })
      return Response.json({ key: { expiresAt: Date.UTC(2027, 1, 13), id: "key-1" }, projectIds: null, roles: ["owner"], team: { id: "t1", name: "Ada's team" }, user: { email: "ada@example.com", id: "u1", name: "Ada" } })
    }
    if (url.pathname === "/api/api-keys/current" && init?.method === "DELETE") {
      revoked = true
      return new Response(null, { status: 204 })
    }
    return Response.json({ code: "NOT_FOUND" }, { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

describe("vitehub login, whoami, and logout", () => {
  it("signs in with the device flow, saves the key with mode 600, and never prints it", async () => {
    const home = await createProject()
    const env = { XDG_CONFIG_HOME: home }
    const console = fakeConsole()
    const login = await runSetup(["login", "--console", `${consoleUrl}/some/path`], home, env, { fetch: console.fetch })
    expect(login.stderr).toBe("")
    expect(login.exitCode).toBe(0)
    expect(login.stdout).toContain(`Open ${consoleUrl}/device and enter the code WDJB-MJHT`)
    expect(login.stdout).toContain(`Signed in to ${consoleUrl} as Ada (ada@example.com) in team Ada's team.`)
    expect(login.stdout + login.stderr).not.toContain(token)
    expect(console.requests.filter(request => request.path === "/api/auth/cli/token")).toHaveLength(2)
    expect(console.requests[0]!.body).toMatchObject({ client_id: "vitehub-cli", client_name: expect.stringMatching(/^vitehub CLI on /) })

    const file = join(home, "vitehub", "credentials.json")
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(home, "vitehub"))).mode & 0o777).toBe(0o700)
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      consoles: { [consoleUrl]: { expiresAt: expect.any(Number), keyId: "key-1", team: { id: "t1", name: "Ada's team" }, token, user: { email: "ada@example.com", id: "u1", name: "Ada" } } },
    })

    const whoami = await runSetup(["whoami"], home, env, { fetch: console.fetch })
    expect(whoami.exitCode).toBe(0)
    expect(whoami.stdout).toBe(`Ada (ada@example.com) in team Ada's team (owner) on ${consoleUrl}\nKey from ${file}, for every project of the team, expires on 13 Feb 2027.\n`)
    expect(console.requests.at(-1)).toMatchObject({ authorization: `Bearer ${token}`, path: "/api/whoami" })

    const json = await runSetup<{ user: { name: string }, source: string }>(["whoami", "--json"], home, env, { fetch: console.fetch })
    expect(json.json).toMatchObject({ console: consoleUrl, schemaVersion: 1, source: file, user: { name: "Ada" } })
    expect(json.stdout).not.toContain(token)

    const logout = await runSetup(["logout"], home, env, { fetch: console.fetch })
    expect(logout.exitCode).toBe(0)
    expect(logout.stdout).toBe(`Signed out of ${consoleUrl}.\n`)
    expect(console.requests.at(-1)).toMatchObject({ authorization: `Bearer ${token}`, method: "DELETE", path: "/api/api-keys/current" })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ consoles: {}, version: 1 })

    const after = await runSetup(["whoami", "--json"], home, env, { fetch: console.fetch })
    expect(after.exitCode).toBe(1)
    expect(after.json).toMatchObject({ error: { code: "CLI_CONSOLE_SIGNED_OUT" } })
  })

  it("keeps the code prompt off stdout with --json", async () => {
    const home = await createProject()
    const console = fakeConsole()
    const login = await runSetup<{ console: string }>(["login", "--console", consoleUrl, "--json"], home, { XDG_CONFIG_HOME: home }, { fetch: console.fetch })
    expect(login.exitCode).toBe(0)
    expect(login.json).toMatchObject({ console: consoleUrl, team: { name: "Ada's team" }, user: { name: "Ada" } })
    expect(login.stderr).toContain("WDJB-MJHT")
    expect(login.stdout + login.stderr).not.toContain(token)
  })

  it("uses VITEHUB_CONSOLE_TOKEN before the saved key", async () => {
    const home = await createProject()
    const console = fakeConsole()
    const whoami = await runSetup(["whoami"], home, { VITEHUB_CONSOLE_TOKEN: token, VITEHUB_CONSOLE_URL: consoleUrl, XDG_CONFIG_HOME: home }, { fetch: console.fetch })
    expect(whoami.exitCode).toBe(0)
    expect(whoami.stdout).toContain("Key from VITEHUB_CONSOLE_TOKEN")
    expect(whoami.stdout).not.toContain(token)
  })

  it("fails when the person denies, and refuses a plain http Console that is not local", async () => {
    const home = await createProject()
    const denied = await runSetup(["login", "--console", consoleUrl], home, { XDG_CONFIG_HOME: home }, { fetch: fakeConsole({ deny: true }).fetch })
    expect(denied.exitCode).toBe(1)
    expect(denied.stderr).toContain("CLI_CONSOLE_LOGIN_FAILED")
    expect(denied.stderr).toContain("denied")
    await expect(stat(join(home, "vitehub", "credentials.json"))).rejects.toThrow()

    const insecure = await runSetup(["login", "--console", "http://console.example.com"], home, { XDG_CONFIG_HOME: home })
    expect(insecure.exitCode).toBe(1)
    expect(insecure.stderr).toContain("https://")
  })

  it("uses the console.url of the app config before the saved logins, after --console and VITEHUB_CONSOLE_URL", async () => {
    const selfHosted = "https://console.self.example"
    const keys: Record<string, string> = { [consoleUrl]: `vhk_${"H".repeat(43)}`, [selfHosted]: `vhk_${"O".repeat(43)}` }
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ console: { url: "${selfHosted}" } }`) })
    await mkdir(join(root, "xdg", "vitehub"), { recursive: true })
    const credential = (key: string) => ({ expiresAt: Date.UTC(2027, 1, 13), keyId: "key-1", team: { id: "t1", name: "Ada's team" }, token: key, user: { email: "ada@example.com", id: "u1", name: "Ada" } })
    await writeFile(join(root, "xdg", "vitehub", "credentials.json"), JSON.stringify({ consoles: { [consoleUrl]: credential(keys[consoleUrl]!), [selfHosted]: credential(keys[selfHosted]!) }, version: 1 }))
    const calls: string[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push(url.origin)
      if (new Headers(init?.headers).get("authorization") !== `Bearer ${keys[url.origin]}`) return Response.json({ code: "CONSOLE_API_KEY_INVALID" }, { status: 401 })
      return Response.json({ key: { expiresAt: Date.UTC(2027, 1, 13), id: "key-1" }, projectIds: null, roles: ["owner"], team: { id: "t1", name: "Ada's team" }, user: { email: "ada@example.com", id: "u1", name: "Ada" } })
    }) as typeof globalThis.fetch
    const env = { XDG_CONFIG_HOME: join(root, "xdg") }

    const fromConfig = await runSetup<{ console: string }>(["whoami", "--json"], root, env, { fetch })
    expect(fromConfig.exitCode).toBe(0)
    expect(fromConfig.json.console).toBe(selfHosted)

    const fromEnv = await runSetup<{ console: string }>(["whoami", "--json"], root, { ...env, VITEHUB_CONSOLE_URL: consoleUrl }, { fetch })
    expect(fromEnv.json.console).toBe(consoleUrl)

    const fromFlag = await runSetup<{ console: string }>(["whoami", "--json", "--console", consoleUrl], root, env, { fetch })
    expect(fromFlag.json.console).toBe(consoleUrl)
    expect(calls).toEqual([selfHosted, consoleUrl, consoleUrl])
  })
})
