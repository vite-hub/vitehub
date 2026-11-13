import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { writeViteHubDevServerFile } from "@vite-hub/internal/cli"
import { consoleBodySha256, createConsoleKeyPair, readConsolePublicKeys, verifyConsoleSignature } from "@vite-hub/internal/console-signature"
import { type AnyOperation, createOperationRegistry, defineOperation, operationExpectedRootsHeader, operationRootHeader, projectRootHash, runOperation } from "@vite-hub/internal/operations"

import { runViteHubCli } from "../src/index.ts"
import { operationRpcRequest, operationRpcResponse } from "./operation-rpc.ts"

/** The private key of the CLI. The app keeps its public key in `VITEHUB_CONSOLE_KEY_CI`. */
const cliPrivateKey = (await createConsoleKeyPair()).privateKey

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
  cli: { positional: ["name"] },
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
    const { input, operation } = operationRpcRequest(init?.body)
    expect(String(url)).toBe(`${origin}/_vitehub/rpc`)
    expect(new Headers(init?.headers).get("x-vitehub-console")).toBe("1")
    expect(new Headers(init?.headers).get("x-vitehub-surface")).toBe("cli")
    const result = await runOperation(registry, operation, input, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
    return operationRpcResponse(init?.body, result, { headers, status: result.ok ? 200 : result.status })
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
  it.each(["", "hello", "hello\n", "héllo 🌍\r\nworld"])("writes formatted file content verbatim: %j", async (content) => {
    const show = defineOperation({
      cli: { format: (output: { content: string }) => output.content, namespace: "workspace" },
      description: "Read a file for redirection.",
      input: v.strictObject({}),
      kind: "read",
      name: "workspace.show",
      run: () => ({ content }),
      section: "workspaces",
    })
    const options = { fetch: server("http://localhost:5173", {}, [show]), operations: [show] }

    const result = await run(["workspace", "show"], options)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(content)
    expect(result.stderr).toBe("")

    const json = await run(["workspace", "show", "--json"], options)
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout)).toEqual({ content })
    expect(json.stdout.endsWith("\n")).toBe(true)
  })

  it("turns a contributed operation into a command with a positional and typed flags", async () => {
    const result = await run(["reports", "list", "acme", "--limit", "5", "--tags", "a,b", "--tags", "c"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ limit: 5, team: "acme" })
    expect(operationRpcRequest(result.fetch.mock.calls[0]![1]!.body)).toEqual({ input: { limit: 5, tags: ["a", "b", "c"], team: "acme" }, operation: "reports.list" })
  })

  it("lists the command in the namespace help and prints usage from the schema", async () => {
    expect((await run(["reports"])).stdout).toContain("list")
    const help = await run(["reports", "list", "--help"])
    expect(help.stdout).toContain("Usage: vitehub reports list <team> [--dry-run] [--limit <value>] [--tags <value>] [--input <json|@file>] [--json] [--url <origin>]")
    expect(help.stdout).toContain("List the reports of a team.")
    expect(help.fetch).not.toHaveBeenCalled()
  })

  it("groups commands with a space under one feature", async () => {
    const jobsList = defineOperation({ cli: { command: "jobs list", namespace: "work" }, description: "List the jobs.", input: v.strictObject({ state: v.optional(v.string()) }), kind: "read", name: "work.jobs-list", run: ({ state }) => ({ jobs: [], state: state ?? null }), section: "work" })
    const jobsClear = defineOperation({ cli: { command: "jobs clear", namespace: "work" }, description: "Remove the jobs.", input: v.strictObject({}), kind: "destructive", name: "work.jobs-clear", run: () => ({ cleared: 2 }), section: "work" })
    const operations = [jobsList, jobsClear]
    const options = { fetch: server("http://localhost:5173", {}, operations), operations }

    const listed = await run(["work", "jobs", "list", "--state", "dead"], options)
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual({ jobs: [], state: "dead" })
    expect(operationRpcRequest(listed.fetch.mock.calls[0]![1]!.body)).toEqual({ input: { state: "dead" }, operation: "work.jobs-list" })

    expect((await run(["work"], options)).stdout).toContain("jobs")
    const help = await run(["work", "jobs", "--help"], options)
    expect(help.stdout).toContain("Usage: vitehub work jobs <clear|list> [args...]")
    expect(help.stdout).toContain("Remove the jobs.")
    expect((await run(["work", "jobs", "list", "--help"], options)).stdout).toContain("Usage: vitehub work jobs list [--state <value>]")
    const unknown = await run(["work", "jobs", "drop"], options)
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("Unknown ViteHub CLI command: work jobs drop")
    expect((await run(["work", "jobs"], options)).code).toBe(1)

    // A destructive command in a group keeps the confirmation rule.
    const refused = await run(["work", "jobs", "clear"], { ...options, fetch: server("http://localhost:5173", {}, operations) })
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("CLI_R0004")
    expect(refused.fetch).not.toHaveBeenCalled()
    const cleared = await run(["work", "jobs", "clear", "--yes"], options)
    expect(JSON.parse(cleared.stdout)).toEqual({ cleared: 2 })
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
    expect(operationRpcRequest(dryRun.fetch.mock.calls[0]![1]!.body).input).toEqual({ dryRun: true, id: "r1" })
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
    expect(operationRpcRequest(fetch.mock.calls[0]![1]!.body).input).toEqual({})
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

  it.each(["fales", "TRUE", "1", ""])("rejects the explicit boolean value %j before dispatch", async value => {
    const result = await run(["reports", "list", "acme", `--dry-run=${value}`, "--json"])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout).error).toMatchObject({ code: "CLI_R0003", message: "--dry-run must be true or false." })
    expect(result.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ["--dry-run", true],
    ["--dry-run=true", true],
    ["--dry-run=false", false],
    ["--no-dry-run", false],
  ] as const)("preserves boolean flag %s", async (flag, expected) => {
    const result = await run(["reports", "list", "acme", flag])
    expect(result.code).toBe(0)
    expect(Reflect.get(Object(operationRpcRequest(result.fetch.mock.calls[0]![1]!.body).input), "dryRun")).toBe(expected)
  })

  it("sends the credentials to the deployed app named by --url", async () => {
    const stdout = stream()
    const stderr = stream()
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://app.example.com/_vitehub/rpc")
      expect(new Headers(init?.headers).get("x-vitehub-signature")).toContain("key=CI")
      expect(new Headers(init?.headers).has(operationExpectedRootsHeader)).toBe(false)
      return operationRpcResponse(init?.body, { ok: true, value: { deployed: true } })
    })
    const plugin = { name: "fixture", vitehub: { operations: [{ export: "ops", load: async () => [list], module: "fixture/operations" }] } }
    const code = await runViteHubCli({ args: ["reports", "list", "acme", "--url", "https://app.example.com"], cwd: "/app", env: { VITEHUB_CONSOLE_PRIVATE_KEY_CI: cliPrivateKey }, fetch: fetch as unknown as typeof globalThis.fetch, loadConfig: async () => ({ plugins: [plugin], root: "/app" }), loadNuxtViteConfig: async () => undefined, stderr, stdout })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.output())).toEqual({ deployed: true })
  })

  describe("deployed RPC targets", () => {
    const env = {
      VITEHUB_CONSOLE_AUTHORIZATION: "Bearer private-token", VITEHUB_CONSOLE_COOKIE: "session=private-cookie",
      VITEHUB_CONSOLE_PRIVATE_KEY_CI: cliPrivateKey,
    }

    it.each([
      "http://app.example.com", "http://localhost.example.com", "ftp://localhost", "not a url",
      "https://user:password@app.example.com", "https://app.example.com?token=private", "https://app.example.com#fragment",
    ])("rejects unsafe URL %s before sending credentials for reads and writes", async (url) => {
      for (const args of [["reports", "list", "acme"], ["reports", "delete", "r1", "--yes", "--json"]]) {
        const fetch = vi.fn(async () => Response.json({ ok: true, value: {} }))
        const result = await run([...args, "--url", url], { env, fetch })
        expect(fetch).not.toHaveBeenCalled()
        expect(result.code).toBe(1)
        expect(result.stderr + result.stdout).toContain("CLI_R0003")
        expect(result.stderr + result.stdout).not.toMatch(/private|access-secret|password/)
      }
    })

    it.each(["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173", "https://app.example.com/base"])("signs calls to safe RPC URL %s, and sends no bearer token or cookie", async (url) => {
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        expect(headers.get("x-vitehub-signature")).toContain("key=CI")
        expect(headers.has("authorization")).toBe(false)
        expect(headers.has("cookie")).toBe(false)
        expect(headers.has(operationExpectedRootsHeader)).toBe(false)
        return operationRpcResponse(init?.body, { ok: true, value: { deployed: true } })
      })
      const result = await run(["reports", "list", "acme", "--url", url], { env, fetch })
      expect(result.code).toBe(0)
      expect(fetch).toHaveBeenCalledExactlyOnceWith(`${url}/_vitehub/rpc`, expect.any(Object))
      expect(JSON.parse(result.stdout)).toEqual({ deployed: true })
    })
  })

  describe("signed calls", () => {
    async function runTrigger(env: NodeJS.ProcessEnv, fetch: ReturnType<typeof vi.fn>, url = "https://app.example.com", args: string[] = []) {
      const stdout = stream()
      const stderr = stream()
      const plugin = { name: "fixture", vitehub: { operations: [{ export: "ops", load: async () => [trigger], module: "fixture/operations" }] } }
      const code = await runViteHubCli({ args: ["triggers", "run", "nightly", "--url", url, "--yes", ...args], cwd: "/app", env, fetch: fetch as unknown as typeof globalThis.fetch, loadConfig: async () => ({ plugins: [plugin], root: "/app" }), loadNuxtViteConfig: async () => undefined, stderr, stdout })
      return { code, stderr: stderr.output(), stdout: stdout.output() }
    }

    it("signs the RPC call with VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>, and the public key verifies it", async () => {
      const { privateKey, publicKey } = await createConsoleKeyPair()
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://app.example.com/_vitehub/rpc")
        const headers = new Headers(init?.headers)
        expect(headers.get("authorization")).toBeNull()
        const keys = readConsolePublicKeys({ VITEHUB_CONSOLE_KEY_CI: publicKey })
        if (!(keys instanceof Map)) throw new Error(keys.message)
        await expect(verifyConsoleSignature({ headers, keys, method: "POST", origin: "https://app.example.com", url: String(url) })).resolves.toEqual({
          bodySha256: await consoleBodySha256(String(init?.body)),
          caller: { via: "cli" },
          key: "CI",
          ok: true,
        })
        return operationRpcResponse(init?.body, { ok: true, value: { run: { id: "r1", name: "nightly" } } })
      })
      const result = await runTrigger({ VITEHUB_CONSOLE_PRIVATE_KEY_CI: privateKey }, fetch)
      expect(result.stderr).toBe("")
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ run: { id: "r1", name: "nightly" } })
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it.each([
      "http://app.example.com", "http://localhost.example.com", "ftp://localhost", "not a url",
      "https://user:password@app.example.com", "https://app.example.com?token=private", "https://app.example.com#fragment",
    ])("rejects unsafe URL %s before sending credentials", async (url) => {
      const fetch = vi.fn(async () => Response.json({ ok: true, value: {} }))
      const result = await runTrigger({ VITEHUB_CONSOLE_COOKIE: "session=private-cookie", VITEHUB_CONSOLE_PRIVATE_KEY_CI: cliPrivateKey }, fetch, url)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("CLI_R0003: --url")
      expect(fetch).not.toHaveBeenCalled()
      expect(result.stderr).not.toMatch(/private|access-secret|password/)
    })

    it.each(["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173", "https://app.example.com/base"])("accepts safe URL %s", async (url) => {
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        expect(headers.get("x-vitehub-signature")).toContain("key=CI")
        return operationRpcResponse(init?.body, { ok: true, value: { run: { id: "r2" } } })
      })
      const result = await runTrigger({ VITEHUB_CONSOLE_PRIVATE_KEY_CI: cliPrivateKey }, fetch, url)
      expect(result.code).toBe(0)
      expect(fetch).toHaveBeenCalledExactlyOnceWith(`${url}/_vitehub/rpc`, expect.any(Object))
    })

    it("names the fix when the app refuses the signature", async () => {
      const { privateKey } = await createConsoleKeyPair()
      const fetch = vi.fn(async () => Response.json({ code: "CONSOLE_KEY_UNKNOWN", fix: "Set the VITEHUB_CONSOLE_KEY_<NAME> line on the app.", message: "This app has no `VITEHUB_CONSOLE_KEY_CI`.", ok: false, status: 401 }, { status: 401 }))
      const result = await runTrigger({ VITEHUB_CONSOLE_PRIVATE_KEY_CI: privateKey }, fetch)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("CONSOLE_KEY_UNKNOWN: This app has no `VITEHUB_CONSOLE_KEY_CI`.")
      expect(result.stderr).toContain("Set the VITEHUB_CONSOLE_KEY_<NAME> line on the app.")
    })

    it("rejects a malformed private key before it calls the app", async () => {
      const fetch = vi.fn()
      const result = await runTrigger({ VITEHUB_CONSOLE_PRIVATE_KEY_CI: "nope" }, fetch)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("VITEHUB_CONSOLE_PRIVATE_KEY_CI must be the 43-character private key")
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
    const result = await run(["reports", "list", "acme"], { env: { VITEHUB_DEV_SERVER_URL: "http://localhost:4000", VITEHUB_CONSOLE_PRIVATE_KEY_CI: cliPrivateKey }, fetch, root })
    expect(result.code).toBe(0)
    expect(fetch).toHaveBeenCalledOnce()
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get(operationExpectedRootsHeader)).toContain(projectRootHash(root))
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("x-vitehub-signature")).toBe(false)
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
    const sent = async (...args: string[]) => operationRpcRequest((await run(["reports", "rich", ...args])).fetch.mock.calls[0]![1]!.body).input
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
    const sent = async (...args: string[]) => operationRpcRequest((await run(["reports", "list", ...args], { cwd: root, root })).fetch.mock.calls[0]![1]!.body).input
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
