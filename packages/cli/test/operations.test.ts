import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { writeViteHubDevServerFile } from "@vite-hub/internal/cli"
import { createOperationRegistry, defineOperation, operationRootHeader, projectRootHash, runOperation } from "@vite-hub/internal/operations"

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
  input: v.strictObject({ dryRun: v.optional(v.boolean()), id: v.string() }),
  kind: "destructive",
  name: "reports.delete",
  readOnlyWhen: input => input.dryRun === true,
  run: ({ id }) => ({ id }),
  section: "reports",
})

const rich = defineOperation({
  description: "Take every kind of flag.",
  input: v.strictObject({
    body: v.optional(v.unknown()),
    count: v.optional(v.union([v.number(), v.null()])),
    items: v.optional(v.array(v.strictObject({ id: v.string() }))),
    label: v.optional(v.nullable(v.string())),
    limit: v.optional(v.pipe(v.number(), v.integer())),
    mixed: v.optional(v.union([v.string(), v.number()])),
    scores: v.optional(v.array(v.number())),
  }),
  kind: "read",
  name: "reports.rich",
  run: input => input,
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

const cleanup: string[] = []

afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { force: true, recursive: true })
})

function stream() {
  let value = ""
  return { output: () => value, write: (chunk: string | Uint8Array) => { value += String(chunk); return true } }
}

const operationList = [list, remove, failing, rich]

// A dev server that runs the operations of the fixture plugin.
function server(origin = "http://localhost:5173", headers: Record<string, string> = {}) {
  const registry = createOperationRegistry([{ operations: operationList }])
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const { input, operation } = JSON.parse(String(init?.body)) as { input: unknown, operation: string }
    expect(String(url)).toBe(`${origin}/_vitehub/rpc/__call`)
    expect(new Headers(init?.headers).get("x-vitehub-console")).toBe("1")
    expect(new Headers(init?.headers).get("x-vitehub-surface")).toBe("cli")
    const result = await runOperation(registry, operation, input, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
    return Response.json(result, { headers, status: result.ok ? 200 : result.status })
  })
}

async function run(args: string[], options: { cwd?: string, env?: NodeJS.ProcessEnv, fetch?: ReturnType<typeof server>, operations?: unknown[], root?: string } = {}) {
  const stdout = stream()
  const stderr = stream()
  const fetch = options.fetch ?? server()
  const plugin = { name: "fixture", vitehub: { operations: [{ export: "ops", load: async () => options.operations ?? operationList, module: "fixture/operations" }] } }
  const root = options.root ?? "/app"
  const code = await runViteHubCli({ args, cwd: options.cwd ?? root, env: options.env ?? { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" }, fetch: fetch as unknown as typeof globalThis.fetch, loadConfig: async () => ({ plugins: [plugin], root }), loadNuxtViteConfig: async () => undefined, stderr, stdout })
  return { code, fetch, stderr: stderr.output(), stdout: stdout.output() }
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-cli-ops-"))
  cleanup.push(root)
  return root
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
    expect(help.stdout).toContain("Usage: vitehub reports list <team> [--dry-run] [--limit <value>] [--tags <value>] [--input <json|@file>] [--json] [--url <origin>]")
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
    // The operation says which calls only read.
    const dryRun = await run(["reports", "delete", "r1", "--dry-run"])
    expect(dryRun.code).toBe(0)
    expect(JSON.parse(String(dryRun.fetch.mock.calls[0]![1]!.body)).input).toEqual({ dryRun: true, id: "r1" })
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

  it("fails with a coded error when no dev server is known, and never guesses a port", async () => {
    const result = await run(["reports", "list", "acme"], { env: {} })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("CLI_R0005: No dev server is running for /app.")
    expect(result.stderr).toContain("Fix: Start `vite dev`")
    expect(result.fetch).not.toHaveBeenCalled()
  })

  it("calls the dev server that wrote .vitehub/dev-server.json for this project", async () => {
    const root = await project()
    writeViteHubDevServerFile(root, { root, url: "http://localhost:5199/" })
    const fetch = server("http://localhost:5199")
    const result = await run(["reports", "list", "acme"], { env: { VITEHUB_DEV_SERVER_URL: "http://localhost:4000" }, fetch, root })
    expect(result.code).toBe(0)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("refuses a dev server that runs another project", async () => {
    const root = await project()
    const other = server("http://localhost:5173", { [operationRootHeader]: projectRootHash("/some/other/project") })
    const refused = await run(["reports", "list", "acme"], { fetch: other, root })
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("INTERNAL_R0025: The server at http://localhost:5173 runs another project")
    const own = server("http://localhost:5173", { [operationRootHeader]: projectRootHash(root) })
    expect((await run(["reports", "list", "acme"], { fetch: own, root })).code).toBe(0)
  })

  it("reports bad JSON with CLI_R0003, never undefined", async () => {
    const result = await run(["reports", "rich", "--body", "{bad"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("--body must be valid JSON")
    expect(result.stderr).toContain("Usage: vitehub reports rich")
    const json = await run(["reports", "rich", "--items", "[bad", "--json"])
    expect(JSON.parse(json.stdout).error).toMatchObject({ code: "CLI_R0003", fix: expect.stringContaining("--help") })
    expect(json.stdout).not.toContain("undefined")
    const input = await run(["reports", "rich", "--input", "{nope"])
    expect(input.stderr).toContain("--input must be valid JSON")
    expect(input.fetch).not.toHaveBeenCalled()
  })

  it("reads every kind of input from flags", async () => {
    const sent = async (...args: string[]) => JSON.parse(String((await run(["reports", "rich", ...args])).fetch.mock.calls[0]![1]!.body)).input
    // JSON for objects, unknown values, and lists of objects.
    expect(await sent("--body", '{"a":[1]}', "--items", '[{"id":"x"}]')).toEqual({ body: { a: [1] }, items: [{ id: "x" }] })
    // A nullable value takes the literal null.
    expect(await sent("--label", "null", "--count", "null")).toEqual({ count: null, label: null })
    expect(await sent("--label", "text", "--count", "3")).toEqual({ count: 3, label: "text" })
    // A string or number union stays a string.
    expect(await sent("--mixed", "12")).toEqual({ mixed: "12" })
    // Lists of numbers parse each item.
    expect(await sent("--scores", "1,2", "--scores", "3")).toEqual({ scores: [1, 2, 3] })
    const wrong = await run(["reports", "rich", "--limit", "1.5"])
    expect(wrong.stderr).toContain("--limit must be a whole number")
  })

  it("takes the whole input from --input, as JSON or from a file, and lets flags override it", async () => {
    const root = await project()
    await writeFile(join(root, "input.json"), JSON.stringify({ limit: 7, team: "from-file" }))
    const sent = async (...args: string[]) => JSON.parse(String((await run(["reports", "list", ...args], { cwd: root, root })).fetch.mock.calls[0]![1]!.body)).input
    expect(await sent("--input", '{"team":"inline","limit":2}')).toEqual({ limit: 2, team: "inline" })
    expect(await sent("--input", "@input.json")).toEqual({ limit: 7, team: "from-file" })
    expect(await sent("--input", "@input.json", "--limit", "9")).toEqual({ limit: 9, team: "from-file" })
    const missing = await run(["reports", "list", "--input", "@nothing.json"], { cwd: root, root })
    expect(missing.stderr).toContain("--input could not read nothing.json")
  })

  it("fails to load when two operations are the same command", async () => {
    const clash = defineOperation({ ...list, name: "reports.other", cli: { command: "list" } })
    await expect(run(["reports"], { operations: [list, clash] })).rejects.toMatchObject({ code: "INTERNAL_B0049" })
  })

  it("lists the operations as a Definition kind", async () => {
    const result = await run(["inspect", "definitions", "--kind", "operation", "--json"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).definitions[0].definitions.map((definition: { name: string }) => definition.name)).toEqual(["reports.delete", "reports.fail", "reports.list", "reports.rich"])
  })
})
