import { execFileSync } from "node:child_process"
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { runViteHubCli } from "../src/index.ts"
import { dotenvLine } from "../src/setup/console-env.ts"
import { createProject } from "./setup-helpers.ts"

const consoleUrl = "https://console.example.com"
const token = `vhk_${"S".repeat(43)}`
const canary = "canary-value-7f3a9c"

/** A Console with env values, or one that keeps them off. It records each request. */
function fakeConsole(options: { keyMissing?: boolean, off?: boolean, projects?: { id: string, url: string }[] } = {}) {
  const requests: { method: string, path: string, authorization: string | null }[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    requests.push({ authorization: headers.get("authorization"), method: init?.method ?? "GET", path: url.pathname })
    if (headers.get("authorization") !== `Bearer ${token}`) return Response.json({ code: "CONSOLE_API_KEY_INVALID" }, { status: 401 })
    if (url.pathname === "/api/projects") return Response.json({ projects: options.projects ?? [{ id: "p1", url: "https://app.example.com" }] })
    if (url.pathname === "/api/projects/p1/env/production/reveal" && init?.method === "POST") {
      if (options.off) return Response.json({ code: "CONSOLE_ENV_VALUES_OFF", message: "This Console does not store env values." }, { status: 404 })
      if (options.keyMissing) return Response.json({ code: "CONSOLE_ENV_KEY_MISSING", fix: "Add the key that sealed the value to VITEHUB_CONSOLE_ENV_KEYS.", message: "A key that this Console does not have sealed API_TOKEN of production." }, { status: 500 })
      return Response.json({ stage: "production", values: { API_TOKEN: canary, GREETING: "hello world", MULTI: "a\nb" } })
    }
    return Response.json({ code: "NOT_FOUND" }, { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

async function gitProject(ignore = ".env.*\n") {
  const root = await createProject({ ".gitignore": ignore, "package.json": "{}" })
  execFileSync("git", ["init", "-q"], { cwd: root, env: { ...process.env, LC_ALL: "C" } })
  return root
}

async function pull(args: string[], cwd: string, fetch: typeof globalThis.fetch) {
  let stdout = ""
  let stderr = ""
  const exitCode = await runViteHubCli({
    args: ["env", "pull", ...args],
    cwd,
    env: { VITEHUB_CONSOLE_TOKEN: token, VITEHUB_CONSOLE_URL: consoleUrl, XDG_CONFIG_HOME: join(cwd, ".config") },
    fetch,
    loadConfig: vi.fn(async () => {
      throw new Error("env pull must not load the config")
    }),
    stderr: { write: (chunk: string | Uint8Array) => { stderr += String(chunk) } },
    stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk) } },
  })
  return { exitCode, stderr, stdout }
}

describe("vitehub env pull --from console", () => {
  it("writes .env.<stage> with mode 600 and prints names, not values", async () => {
    const root = await gitProject()
    const console = fakeConsole()
    const run = await pull(["--from", "console"], root, console.fetch)
    expect(run.stderr).toBe("")
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain("Wrote 3 values of production to .env.production (mode 600): API_TOKEN, GREETING, MULTI.")
    expect(run.stdout).not.toContain(canary)
    const file = join(root, ".env.production")
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const text = await readFile(file, "utf8")
    expect(text).toContain(`API_TOKEN=${canary}\n`)
    expect(text).toContain("GREETING='hello world'\n")
    expect(text).toContain("MULTI=\"a\\nb\"\n")
    expect(console.requests.map(request => `${request.method} ${request.path}`)).toEqual(["GET /api/projects", "POST /api/projects/p1/env/production/reveal"])
  })

  it("does not replace a file without --yes, and keeps mode 600 with it", async () => {
    const root = await gitProject()
    const file = join(root, ".env.production")
    await writeFile(file, "OLD=1\n")
    await chmod(file, 0o644)
    const refused = await pull(["--from", "console", "--project", "p1"], root, fakeConsole().fetch)
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr).toContain("CLI_ENV_FILE_EXISTS")
    expect(refused.stderr).toContain("Pass --yes")
    expect(await readFile(file, "utf8")).toBe("OLD=1\n")

    const replaced = await pull(["--from", "console", "--project", "p1", "--yes"], root, fakeConsole().fetch)
    expect(replaced.exitCode).toBe(0)
    expect(await readFile(file, "utf8")).toContain(`API_TOKEN=${canary}`)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it("refuses a file that git would commit, before it asks the Console", async () => {
    const unignored = await gitProject("node_modules\n")
    const console = fakeConsole()
    const run = await pull(["--from", "console"], unignored, console.fetch)
    expect(run.exitCode).not.toBe(0)
    expect(run.stderr).toContain("CLI_ENV_FILE_NOT_IGNORED")
    expect(run.stderr).toContain("echo '.env.*' >> .gitignore")
    expect(console.requests).toEqual([])

    const tracked = await gitProject("node_modules\n")
    await writeFile(join(tracked, ".env.production"), "PUBLIC=1\n")
    execFileSync("git", ["add", ".env.production"], { cwd: tracked })
    await writeFile(join(tracked, ".gitignore"), ".env.*\n")
    const trackedRun = await pull(["--from", "console", "--yes"], tracked, console.fetch)
    expect(trackedRun.exitCode).not.toBe(0)
    expect(trackedRun.stderr).toContain("git rm --cached .env.production")
    expect(await readFile(join(tracked, ".env.production"), "utf8")).toBe("PUBLIC=1\n")
    expect(console.requests).toEqual([])
  })

  it("asks for --project when the key opens several, and shows the Console's answer when values are off", async () => {
    const root = await gitProject()
    const several = await pull(["--from", "console"], root, fakeConsole({ projects: [{ id: "p1", url: "https://a.example.com" }, { id: "p2", url: "https://b.example.com" }] }).fetch)
    expect(several.exitCode).not.toBe(0)
    expect(several.stderr).toContain("Pass --project <id>: p1 (https://a.example.com), p2 (https://b.example.com)")

    const off = await pull(["--from", "console", "--project", "p1"], root, fakeConsole({ off: true }).fetch)
    expect(off.exitCode).not.toBe(0)
    expect(off.stderr).toContain("CONSOLE_ENV_VALUES_OFF")
    expect(off.stderr).toContain("does not store env values")
    await expect(stat(join(root, ".env.production"))).rejects.toThrow()

    // A coded answer of the Console carries its fix, which the CLI prints too.
    const keyMissing = await pull(["--from", "console", "--project", "p1"], root, fakeConsole({ keyMissing: true }).fetch)
    expect(keyMissing.exitCode).not.toBe(0)
    expect(keyMissing.stderr).toContain("CONSOLE_ENV_KEY_MISSING")
    expect(keyMissing.stderr).toContain("Add the key that sealed the value to VITEHUB_CONSOLE_ENV_KEYS.")

    const noFrom = await pull([], root, fakeConsole().fetch)
    expect(noFrom.stderr).toContain("--from console")
  })

  it("writes outside a git repository", async () => {
    const root = await createProject({ "package.json": "{}" })
    await mkdir(join(root, ".config"), { recursive: true })
    const run = await pull(["--from", "console", "--stage", "production"], root, fakeConsole().fetch)
    expect(run.stderr).toBe("")
    expect(run.exitCode).toBe(0)
  })

  it("quotes values that a .env parser could misread", () => {
    expect(dotenvLine("A", "plain-value_1.2")).toBe("A=plain-value_1.2")
    expect(dotenvLine("A", "has space # and hash")).toBe("A='has space # and hash'")
    expect(dotenvLine("A", "it's \"quoted\"")).toBe("A=\"it's \\\"quoted\\\"\"")
  })
})
