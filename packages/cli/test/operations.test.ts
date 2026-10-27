import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { writeViteHubDevServerFile } from "@vite-hub/internal/cli"
import { type AnyOperation, createOperationRegistry, defineOperation, operationExpectedRootsHeader, operationRootHeader, projectRootHash, runOperation } from "@vite-hub/internal/operations"

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

const digest = defineOperation({
  cli: { default: true },
  description: "Read the digest.",
  input: v.strictObject({ window: v.optional(v.string()) }),
  kind: "read",
  name: "digest.get",
  run: ({ window }) => ({ window: window ?? "day" }),
  section: "digest",
})

const trigger = defineOperation({
  cli: { dispatch: "/_vitehub/triggers/run", positional: ["name"] },
  description: "Run a trigger now.",
  input: v.strictObject({ name: v.string() }),
  kind: "write",
  name: "triggers.run",
  run: ({ name }) => ({ run: { id: "r1", name } }),
  section: "triggers",
})

const cleanup: string[] = []

afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { force: true, recursive: true })
})

function stream() {
  let value = ""
  return { output: () => value, write: (chunk: string | Uint8Array) => { value += String(chunk); return true } }
}

const operationList = [list, remove, failing, rich, digest]

// A dev server that runs the operations of the fixture plugin.
function server(origin = "http://localhost:5173", headers: Record<string, string> = {}, operations: readonly AnyOperation[] = operationList) {
  const registry = createOperationRegistry([{ operations }])
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

  it("runs the default command of a namespace when none is named", async () => {
    const bare = await run(["digest"])
    expect(bare.code).toBe(0)
    expect(JSON.parse(bare.stdout)).toEqual({ window: "day" })
    const flagged = await run(["digest", "--window", "week", "--json"])
    expect(JSON.parse(flagged.stdout)).toEqual({ window: "week" })
    expect((await run(["digest", "get", "--window", "week"])).code).toBe(0)
    const help = await run(["digest", "--help"])
    expect(help.stdout).toContain("get")
    expect(help.fetch).not.toHaveBeenCalled()
  })

  it("needs --yes for a destructive operation without a terminal, and no --yes for a dry run", async () => {
    const refused = await run(["reports", "delete", "r1"])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("CLI_R0004")
    expect(refused.stderr).toContain("Fix: Run it again with --yes")
    expect(refused.fetch).not.toHaveBeenCalled()
    const confirmed = await run(["reports", "delete", "r1", "--yes"])
    expect(confirmed.code).toBe(0)
    expect(new Headers(confirmed.fetch.mock.calls[0]![1]!.headers).get("x-vitehub-confirmation")).toBe("confirmed")
    // The operation says which calls only read.
    const dryRun = await run(["reports", "delete", "r1", "--dry-run"])
    expect(dryRun.code).toBe(0)
    expect(new Headers(dryRun.fetch.mock.calls[0]![1]!.headers).get("x-vitehub-confirmation")).toBe("required")
    expect(JSON.parse(String(dryRun.fetch.mock.calls[0]![1]!.body)).input).toEqual({ dryRun: true, id: "r1" })
  })

  it("reports missing nested input before calling readOnlyWhen", async () => {
    const readOnlyWhen = vi.fn((input: { options: { dryRun: boolean } }) => input.options.dryRun)
    const operation = defineOperation({ description: "Validate nested input.", kind: "destructive", section: "reports", name: "reports.nested", input: v.object({ options: v.object({ dryRun: v.boolean() }) }), readOnlyWhen, run: input => input })
    const result = await run(["reports", "nested", "--json"], { operations: [operation] })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout).error.code).toBe("INTERNAL_R0022")
    expect(readOnlyWhen).not.toHaveBeenCalled()
    expect(result.fetch).not.toHaveBeenCalled()
  })

  it("uses defaults and transforms for confirmation without transforming the request twice", async () => {
    const operation = defineOperation({
      description: "Normalize input before confirmation.",
      kind: "destructive",
      section: "reports",
      name: "reports.normalized",
      input: v.object({ options: v.optional(v.object({ dryRun: v.pipe(v.boolean(), v.transform(value => !value)) }), { dryRun: false }) }),
      readOnlyWhen: input => input.options.dryRun,
      run: input => input,
    })
    const fetch = server("http://localhost:5173", {}, [operation])
    const result = await run(["reports", "normalized"], { operations: [operation], fetch })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ options: { dryRun: true } })
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).input).toEqual({})
  })

  it.each(["inspect", "provision"])("diagnoses a generated command in the reserved %s namespace", async namespace => {
    const operation = defineOperation({ ...list, name: "reports.custom", cli: { namespace } })
    await expect(run([namespace, "custom"], { operations: [operation] })).rejects.toMatchObject({ code: "INTERNAL_R0020", message: expect.stringContaining("reserved") })
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
      expect(new Headers(init?.headers).has(operationExpectedRootsHeader)).toBe(false)
      return Response.json({ ok: true, value: { deployed: true } })
    })
    const plugin = { name: "fixture", vitehub: { operations: [{ export: "ops", load: async () => [list], module: "fixture/operations" }] } }
    const code = await runViteHubCli({ args: ["reports", "list", "acme", "--url", "https://app.example.com"], cwd: "/app", env: { VITEHUB_CONSOLE_AUTHORIZATION: "Bearer token" }, fetch: fetch as unknown as typeof globalThis.fetch, loadConfig: async () => ({ plugins: [plugin], root: "/app" }), loadNuxtViteConfig: async () => undefined, stderr, stdout })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.output())).toEqual({ deployed: true })
  })

  describe("signed dispatch", () => {
    const key = "ab".repeat(32)

    async function runTrigger(env: NodeJS.ProcessEnv, fetch: ReturnType<typeof vi.fn>, url = "https://app.example.com", args: string[] = []) {
      const stdout = stream()
      const stderr = stream()
      const plugin = { name: "fixture", vitehub: { operations: [{ export: "ops", load: async () => [trigger], module: "fixture/operations" }] } }
      const code = await runViteHubCli({ args: ["triggers", "run", "nightly", "--url", url, "--yes", ...args], cwd: "/app", env, fetch: fetch as unknown as typeof globalThis.fetch, loadConfig: async () => ({ plugins: [plugin], root: "/app" }), loadNuxtViteConfig: async () => undefined, stderr, stdout })
      return { code, stderr: stderr.output(), stdout: stdout.output() }
    }

    it("signs the input with VITEHUB_DISPATCH_KEY and posts it to the dispatch route", async () => {
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://app.example.com/_vitehub/triggers/run")
        const headers = new Headers(init?.headers)
        expect(headers.get("x-vitehub-dispatch-signature")).toMatch(/^v1=[0-9a-f]{64}$/)
        expect(headers.get("x-vitehub-dispatch-timestamp")).toBeTruthy()
        expect(headers.get("x-vitehub-dispatch-nonce")).toBeTruthy()
        expect(headers.get("authorization")).toBeNull()
        expect(JSON.parse(String(init?.body))).toEqual({ name: "nightly" })
        return Response.json({ run: { id: "r1", name: "nightly" } })
      })
      const result = await runTrigger({ VITEHUB_DISPATCH_KEY: key }, fetch)
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ run: { id: "r1", name: "nightly" } })
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it("forwards Access service tokens without Console session credentials", async () => {
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        expect(headers.get("cf-access-client-id")).toBe("access-id")
        expect(headers.get("cf-access-client-secret")).toBe("access-secret")
        expect(headers.get("authorization")).toBeNull()
        expect(headers.get("cookie")).toBeNull()
        return Response.json({ run: { id: "r1" } })
      })
      const result = await runTrigger({ VITEHUB_DISPATCH_KEY: key, CF_ACCESS_CLIENT_ID: "access-id", CF_ACCESS_CLIENT_SECRET: "access-secret", VITEHUB_CONSOLE_AUTHORIZATION: "Bearer console-token", VITEHUB_CONSOLE_COOKIE: "session=console-cookie" }, fetch)
      expect(result.code).toBe(0)
      expect(fetch).toHaveBeenCalledOnce()
    })

    it.each([
      ["http://app.example.com", "must use HTTPS"],
      ["http://localhost.example.com", "must use HTTPS"],
      ["ftp://localhost", "must use HTTPS"],
      ["not a url", "must be a URL"],
      ["https://user:password@app.example.com", "must not contain credentials"],
      ["https://app.example.com?token=private", "must not contain credentials"],
      ["https://app.example.com#fragment", "must not contain credentials"],
    ])("rejects unsafe dispatch URL %s without fetching", async (url, message) => {
      const fetch = vi.fn(async () => Response.json({ run: { id: "r1" } }))
      const result = await runTrigger({ VITEHUB_DISPATCH_KEY: key }, fetch, url)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`CLI_R0003: --url ${message}`)
      expect(fetch).not.toHaveBeenCalled()
    })

    it.each(["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173", "https://app.example.com/base"])("accepts dispatch URL %s", async (url) => {
      const fetch = vi.fn(async () => Response.json({ run: { id: "r1" } }))
      expect((await runTrigger({ VITEHUB_DISPATCH_KEY: key }, fetch, url)).code).toBe(0)
      expect(fetch.mock.calls[0]).toEqual([`${url}/_vitehub/triggers/run`, expect.any(Object)])
    })

    it.each([[], ["--json"]])("redacts signed results and failures with flags %j", async (...args) => {
      const message = "Request failed: Bearer fake-token at https://user:fake-password@example.com"
      const outputs = [
        vi.fn(async () => Response.json({ run: { id: "r1", error: { name: "token=fake-name", message } }, items: Array.from({ length: 120 }, (_, i) => i), text: "x".repeat(11_000) })),
        vi.fn(async () => Response.json({ message }, { status: 500 })),
        vi.fn(async () => { throw new Error(message) }),
      ]
      for (const [index, fetch] of outputs.entries()) {
        const result = await runTrigger({ VITEHUB_DISPATCH_KEY: key }, fetch, undefined, args)
        const output = result.stdout + result.stderr
        expect(output).toContain("[redacted]")
        expect(output).not.toContain("fake-token")
        expect(output).not.toContain("fake-password")
        expect(output).not.toContain("fake-name")
        expect(result.code).toBe(index === 0 ? 0 : 1)
        if (index === 0) {
          const value = JSON.parse(result.stdout)
          expect(value.items).toHaveLength(120)
          expect(value.text).toHaveLength(11_000)
        }
      }
    })

    it.each([[], ["--json"]])("redacts nested secret-named fields without truncating signed results with flags %j", async (...args) => {
      const fetch = vi.fn(async () => Response.json({
        run: { details: { token: "opaque-token", password: "opaque-password", authorization: "opaque-authorization", cookie: "opaque-cookie", apiKey: { value: "opaque-key" } } },
        items: Array.from({ length: 120 }, (_, i) => ({ id: i, credential: "opaque-credential" })),
        text: "x".repeat(11_000),
      }))
      const result = await runTrigger({ VITEHUB_DISPATCH_KEY: key }, fetch, undefined, args)
      expect(result.code).toBe(0)
      const value = JSON.parse(result.stdout)
      expect(value.run.details).toEqual({ token: "[redacted]", password: "[redacted]", authorization: "[redacted]", cookie: "[redacted]", apiKey: "[redacted]" })
      expect(value.items).toEqual(Array.from({ length: 120 }, (_, i) => ({ id: i, credential: "[redacted]" })))
      expect(value.text).toBe("x".repeat(11_000))
      expect(result.stdout).not.toContain("opaque-")
    })

    it("uses the RPC with Console credentials when no key is set", async () => {
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://app.example.com/_vitehub/rpc/__call")
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token")
        return Response.json({ ok: true, value: { run: { id: "r2" } } })
      })
      const result = await runTrigger({ VITEHUB_CONSOLE_AUTHORIZATION: "Bearer token" }, fetch)
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ run: { id: "r2" } })
    })

    it("names the key when the app refuses the signature", async () => {
      const fetch = vi.fn(async () => Response.json({ message: "The dispatch signature does not match." }, { status: 401 }))
      const result = await runTrigger({ VITEHUB_DISPATCH_KEY: key }, fetch)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("CLI_R0006: The signed request failed with HTTP 401: The dispatch signature does not match.")
      expect(result.stderr).toContain("VITEHUB_DISPATCH_KEY")
    })

    it("rejects a malformed key before it calls the app", async () => {
      const fetch = vi.fn()
      const result = await runTrigger({ VITEHUB_DISPATCH_KEY: "nope" }, fetch)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("VITEHUB_DISPATCH_KEY must be the 64-character hex key")
      expect(fetch).not.toHaveBeenCalled()
    })
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
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get(operationExpectedRootsHeader)).toContain(projectRootHash(root))
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
    expect(JSON.parse(result.stdout).definitions[0].definitions.map((definition: { name: string }) => definition.name)).toEqual(["digest.get", "reports.delete", "reports.fail", "reports.list", "reports.rich"])
  })
})
