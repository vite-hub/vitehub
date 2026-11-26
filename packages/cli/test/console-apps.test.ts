import { describe, expect, it } from "vitest"

import { consoleEnv as env, consoleToken as token, consoleUrl, fakeConsole } from "./fake-console.ts"
import { createProject, runSetup } from "./setup-helpers.ts"

import type { FakeApp } from "./fake-console.ts"

describe("vitehub apps", () => {
  it("links an app, links it again with the same key, lists, and checks it", async () => {
    const home = await createProject()
    const console = fakeConsole()

    const empty = await runSetup(["apps", "list"], home, env(home), { fetch: console.fetch })
    expect(empty.exitCode).toBe(0)
    expect(empty.stdout).toContain("Team Acme has no apps.")

    const linked = await runSetup<{ app: FakeApp, variable: string, next: string }>(["apps", "link", "https://app.example.com", "--label", "Docs", "--json"], home, env(home), { fetch: console.fetch })
    expect(linked.exitCode).toBe(0)
    expect(linked.json).toMatchObject({ app: { id: "a1b2c3d4-0", label: "Docs" }, console: consoleUrl, schemaVersion: 1, variable: "VITEHUB_CONSOLE_KEY_CONSOLE_A1B2C3D4=pk" })
    expect(linked.json.next).toContain("vitehub apps check a1b2c3d4-0")
    expect(console.requests.at(-1)).toMatchObject({ body: { label: "Docs", url: "https://app.example.com" }, method: "POST", path: "/api/projects" })
    expect(linked.stdout).not.toContain(token)

    const again = await runSetup(["apps", "link", "https://app.example.com/"], home, env(home), { fetch: console.fetch })
    expect(again.exitCode).toBe(0)
    expect(again.stdout).toContain("Already linked Docs (https://app.example.com) as a1b2c3d4-0.\nVITEHUB_CONSOLE_KEY_CONSOLE_A1B2C3D4=pk\n")
    expect(console.apps).toHaveLength(1)

    const list = await runSetup<{ apps: FakeApp[], team: object }>(["apps", "list", "--json"], home, env(home), { fetch: console.fetch })
    expect(list.json).toMatchObject({ apps: [{ id: "a1b2c3d4-0" }], team: { id: "t1", name: "Acme", role: "owner" } })
    expect((await runSetup(["apps", "list"], home, env(home), { fetch: console.fetch })).stdout).toMatch(/^id\s+label\s+url\s+kind\na1b2c3d4-0\s+Docs\s+https:\/\/app\.example\.com\s+app\n$/)

    const unlinkedApp = await runSetup<{ linked: boolean, status: number }>(["apps", "check", "a1b2c3d4-0", "--json"], home, env(home), { fetch: console.fetch })
    expect(unlinkedApp.exitCode).toBe(1)
    expect(unlinkedApp.json).toMatchObject({ linked: false, status: 401 })
    const text = await runSetup(["apps", "check", "a1b2c3d4-0"], home, env(home), { fetch: console.fetch })
    expect(text.stdout).toBe("The app does not accept the Console yet: 401 CONSOLE_KEY_UNKNOWN: The app has no key for this Console.\n")

    const ok = await runSetup(["apps", "check", "a1b2c3d4-0"], home, env(home), { fetch: fakeConsole({ appKnowsKey: true }).fetch })
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout).toBe(`The app answers signed requests of ${consoleUrl}.\n`)
  })

  it("prints a check command for the selected Console and includes the Node prerequisite", async () => {
    const home = await createProject()
    const console = fakeConsole({ appKnowsKey: true })
    const origin = "https://other-console.example.com"
    const linked = await runSetup<{ next: string }>(["apps", "link", "https://app.example.com", "--console", `${origin}/`, "--json"], home, env(home), { fetch: console.fetch })
    expect(linked.exitCode).toBe(0)
    expect(linked.json.next).toContain('publicUrl: "https://app.example.com"')
    const command = linked.json.next.match(/`(vitehub apps check [^`]+)`/)?.[1]
    expect(command).toBe(`vitehub apps check a1b2c3d4-0 --console ${origin}`)
    const checked = await runSetup(command!.split(" ").slice(1), home, env(home), { fetch: console.fetch })
    expect(checked.exitCode).toBe(0)
    expect(console.requests.map(request => request.origin)).toEqual([origin, origin])
  })

  it("registers a site with --kind site and prints its script tag", async () => {
    const home = await createProject()
    const console = fakeConsole()
    const site = await runSetup<{ script: string }>(["apps", "link", "https://site.example.com", "--kind", "site", "--json"], home, env(home), { fetch: console.fetch })
    expect(site.exitCode).toBe(0)
    expect(site.json.script).toBe(`<script type="module" src="${consoleUrl}/hosted-comments.js" data-vitehub-comments="a1b2c3d4-0"></script>`)
    expect(console.requests.at(-1)?.body).toEqual({ kind: "site", url: "https://site.example.com" })
    const wrong = await runSetup(["apps", "link", "https://site.example.com", "--kind", "app"], home, env(home), { fetch: console.fetch })
    expect(wrong.exitCode).toBe(1)
    expect(wrong.stderr).toContain("--kind takes only \"site\"")
  })

  it("unlinks only with --delete-hosted-comments", async () => {
    const home = await createProject()
    const console = fakeConsole()
    await runSetup(["apps", "link", "https://app.example.com"], home, env(home), { fetch: console.fetch })
    const refused = await runSetup(["apps", "unlink", "a1b2c3d4-0"], home, env(home), { fetch: console.fetch })
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("--delete-hosted-comments")
    expect(console.requests.some(request => request.method === "DELETE")).toBe(false)

    const unlinked = await runSetup<{ unlinked: string, next: string }>(["apps", "unlink", "a1b2c3d4-0", "--delete-hosted-comments", "--json"], home, env(home), { fetch: console.fetch })
    expect(unlinked.exitCode).toBe(0)
    expect(unlinked.json).toMatchObject({ next: "Remove VITEHUB_CONSOLE_KEY_CONSOLE_A1B2C3D4 from the environment of https://app.example.com.", unlinked: "a1b2c3d4-0" })
    expect(console.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/api/projects/a1b2c3d4-0", search: "?deleteHostedComments=true" })
    expect(console.apps).toHaveLength(0)
  })

  it("requires a delete acknowledgment before reporting an unlink", async () => {
    const home = await createProject()
    const console = fakeConsole({ deleteResponse: new Response("Sign in", { headers: { "content-type": "text/html" } }) })
    await runSetup(["apps", "link", "https://app.example.com"], home, env(home), { fetch: console.fetch })
    const result = await runSetup(["apps", "unlink", "a1b2c3d4-0", "--delete-hosted-comments"], home, env(home), { fetch: console.fetch })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("expected status 204")
    expect(console.apps).toHaveLength(1)
  })

  it("passes the Console's refusal on, and asks for a login without a key", async () => {
    const home = await createProject()
    const member = await runSetup<{ error: { code: string, why: string } }>(["apps", "link", "https://app.example.com", "--json"], home, env(home), { fetch: fakeConsole({ role: "member" }).fetch })
    expect(member.exitCode).toBe(1)
    expect(member.json.error).toMatchObject({ code: "CLI_CONSOLE_REQUEST_FAILED" })
    expect(member.json.error.why).toContain("CONSOLE_PROJECT_FORBIDDEN")

    const signedOut = await runSetup<{ error: { code: string } }>(["apps", "list", "--json"], home, { VITEHUB_CONSOLE_URL: consoleUrl, XDG_CONFIG_HOME: home })
    expect(signedOut.exitCode).toBe(1)
    expect(signedOut.json.error.code).toBe("CLI_CONSOLE_SIGNED_OUT")

    const usage = await runSetup(["apps", "check"], home, env(home))
    expect(usage.exitCode).toBe(1)
    expect(usage.stderr).toContain("Pass one app id.")
  })
})
