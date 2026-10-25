import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"
import { createOperationRegistry, defineOperation, runOperation } from "@vite-hub/internal/operations"

import { runViteHubCli } from "../src/index.ts"

const list = defineOperation({
  cli: { positional: ["team"] },
  description: "List the reports of a team.",
  input: v.strictObject({ dryRun: v.optional(v.boolean()), limit: v.optional(v.number()), tags: v.optional(v.array(v.string())), team: v.string() }),
  kind: "read",
  name: "reports.list",
  run: ({ limit, team }) => ({ limit: limit ?? null, team }),
  section: "reports",
})

const remove = defineOperation({
  cli: { positional: ["id"] },
  description: "Delete one report.",
  input: v.strictObject({ id: v.string() }),
  kind: "destructive",
  name: "reports.delete",
  run: ({ id }) => ({ id }),
  section: "reports",
})

const failing = defineOperation({
  description: "Always fails.",
  input: v.strictObject({}),
  kind: "write",
  name: "reports.fail",
  run: () => {
    throw Object.assign(new Error("No report exists."), { code: "REPORTS_R0001", fix: "Create a report first.", status: 404 })
  },
  section: "reports",
})

function stream() {
  let value = ""
  return { output: () => value, write: (chunk: string | Uint8Array) => { value += String(chunk); return true } }
}

// A dev server that runs the operations of the fixture plugin.
function server() {
  const registry = createOperationRegistry([{ operations: [list, remove, failing] }])
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const { input, operation } = JSON.parse(String(init?.body)) as { input: unknown, operation: string }
    expect(String(url)).toBe("http://localhost:5173/_vitehub/rpc/__call")
    expect(new Headers(init?.headers).get("x-vitehub-console")).toBe("1")
    const result = await runOperation(registry, operation, input, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
    return Response.json(result, { status: result.ok ? 200 : result.status })
  })
}

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const stdout = stream()
  const stderr = stream()
  const fetch = server()
  const plugin = { name: "fixture", vitehub: { operations: [{ export: "ops", load: async () => [list, remove, failing], module: "fixture/operations" }] } }
  const code = await runViteHubCli({ args, cwd: "/app", env, fetch: fetch as unknown as typeof globalThis.fetch, loadConfig: async () => ({ plugins: [plugin], root: "/app" }), loadNuxtViteConfig: async () => undefined, stderr, stdout })
  return { code, fetch, stderr: stderr.output(), stdout: stdout.output() }
}

describe("generated operation commands", () => {
  it("turns a contributed operation into a command with a positional and typed flags", async () => {
    const result = await run(["reports", "list", "acme", "--limit", "5", "--tags", "a,b", "--tags", "c"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ limit: 5, team: "acme" })
    expect(JSON.parse(String(result.fetch.mock.calls[0]![1]!.body))).toEqual({ input: { limit: 5, tags: ["a", "b", "c"], team: "acme" }, operation: "reports.list" })
  })

  it("lists the command in the namespace help and prints usage from the schema", async () => {
    expect((await run(["reports"])).stdout).toContain("list")
    const help = await run(["reports", "list", "--help"])
    expect(help.stdout).toContain("Usage: vitehub reports list <team> [--dry-run] [--limit <value>] [--tags <value>] [--json] [--url <origin>]")
    expect(help.stdout).toContain("List the reports of a team.")
    expect(help.fetch).not.toHaveBeenCalled()
  })

  it("needs --yes for a destructive operation without a terminal, and no --yes for a dry run", async () => {
    const refused = await run(["reports", "delete", "r1"])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("CLI_R0004")
    expect(refused.stderr).toContain("Fix: Run it again with --yes")
    expect(refused.fetch).not.toHaveBeenCalled()
    expect((await run(["reports", "delete", "r1", "--yes"])).code).toBe(0)
    expect((await run(["reports", "list", "acme", "--dry-run"])).code).toBe(0)
  })

  it("prints the code, message, and fix of a failure, and exits with 1", async () => {
    const result = await run(["reports", "fail"])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe("REPORTS_R0001: No report exists.\nFix: Create a report first.\n")
    const json = await run(["reports", "fail", "--json"])
    expect(JSON.parse(json.stdout)).toEqual({ error: { code: "REPORTS_R0001", fix: "Create a report first.", message: "No report exists." } })
  })

  it("rejects an unknown option before it calls the app", async () => {
    const result = await run(["reports", "list", "acme", "--nope", "1"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Unknown option --nope")
    expect(result.fetch).not.toHaveBeenCalled()
  })

  it("sends the credentials to the deployed app named by --url", async () => {
    const stdout = stream()
    const stderr = stream()
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://app.example.com/_vitehub/rpc/__call")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token")
      return Response.json({ ok: true, value: { deployed: true } })
    })
    const plugin = { name: "fixture", vitehub: { operations: [{ export: "ops", load: async () => [list], module: "fixture/operations" }] } }
    const code = await runViteHubCli({ args: ["reports", "list", "acme", "--url", "https://app.example.com"], cwd: "/app", env: { VITEHUB_CONSOLE_AUTHORIZATION: "Bearer token" }, fetch: fetch as unknown as typeof globalThis.fetch, loadConfig: async () => ({ plugins: [plugin], root: "/app" }), loadNuxtViteConfig: async () => undefined, stderr, stdout })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.output())).toEqual({ deployed: true })
  })

  it("lists the operations as a Definition kind", async () => {
    const result = await run(["inspect", "definitions", "--kind", "operation", "--json"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).definitions[0].definitions.map((definition: { name: string }) => definition.name)).toEqual(["reports.delete", "reports.fail", "reports.list"])
  })
})
