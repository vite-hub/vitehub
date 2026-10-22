import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@vite-hub/internal/dev-token", async importOriginal => ({
  ...await importOriginal<typeof import("@vite-hub/internal/dev-token")>(),
  readViteHubDevToken: async () => "test-task-token",
}))

const runTask = vi.hoisted(() => vi.fn())
vi.mock("nitro/task", () => ({ runTask }))

import { handleTaskDevRequest } from "../src/_internal/task/runtime/dev.ts"
import { runTaskCli } from "../src/task/cli.ts"
import { taskDevHeader, taskDevHeaderValue, taskDevRoute, taskDevRuntimeRoute, taskDevTokenServerHeader } from "../src/task/dev.ts"
import { discoverTaskDefinitions } from "../src/task/discovery.ts"
import { viteHubTaskPlugin } from "../src/task/vite.ts"

const rootDir = "/app"
const roots: string[] = []

afterEach(async () => {
  runTask.mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-task-"))
  roots.push(root)
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), contents)
  }
  return root
}

function stream() {
  let value = ""
  return { output: () => value, write: (chunk: string | Uint8Array) => { value += String(chunk) } }
}

function context() {
  const stdout = stream()
  const stderr = stream()
  return { context: { env: {}, rootDir, stderr, stdout }, stderr, stdout }
}

/** Fake dev server: `GET` discovery, then one `POST` operation. */
function devServer(result: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
    ? Response.json(result, { status })
    : Response.json({ root: rootDir, runtime: "nitro", taskDevTokenServerId: "test-server" }))
}

async function runConfigHook(root: string, nitro?: Record<string, unknown>, command: "build" | "serve" = "build") {
  const plugin = viteHubTaskPlugin()
  const config: { nitro?: unknown, root: string } = { nitro, root }
  const hook = plugin.config
  if (typeof hook !== "function") throw new TypeError("The task plugin has no config hook.")
  await hook.call({} as never, config as never, { command, mode: "development" })
  return { config, plugin }
}

describe("task discovery", () => {
  it("names tasks like Nitro: nested paths use colons and index files use the folder", async () => {
    const root = await project({
      "server/tasks/db/seed.ts": "",
      "server/tasks/cleanup.ts": "",
      "server/tasks/reports/index.ts": "",
      "server/tasks/types.d.ts": "",
    })
    expect(discoverTaskDefinitions(root).map(definition => definition.name)).toEqual(["cleanup", "db:seed", "reports"])
  })
})

describe("viteHubTaskPlugin", () => {
  it("enables Nitro tasks and registers the discovered files", async () => {
    const root = await project({ "server/tasks/db/seed.ts": "" })
    const { config } = await runConfigHook(root, { tasks: { "db:seed": { description: "Seed" } } })
    expect(config.nitro).toEqual({
      experimental: { tasks: true },
      tasks: { "db:seed": { description: "Seed", handler: join(root, "server/tasks/db/seed.ts") } },
    })
  })

  it("leaves Nitro alone without task files, and respects experimental.tasks: false", async () => {
    const empty = await project({})
    expect((await runConfigHook(empty)).config.nitro).toBeUndefined()

    const optedOut = await project({ "server/tasks/seed.ts": "" })
    expect((await runConfigHook(optedOut, { experimental: { tasks: false } })).config.nitro).toEqual({ experimental: { tasks: false } })
  })

  it("enables the endpoint for tasks declared in Nitro config", async () => {
    const empty = await project({})
    expect((await runConfigHook(empty, { tasks: { seed: { handler: "/tmp/seed.ts" } } })).config.nitro).toEqual({
      experimental: { tasks: true },
      tasks: { seed: { handler: "/tmp/seed.ts" } },
    })
  })

  it("adds the dev-only Nitro handler in serve mode and lists tasks for inspection", async () => {
    const root = await project({ "server/tasks/seed.ts": "" })
    const { config, plugin } = await runConfigHook(root, undefined, "serve")
    expect(config.nitro).toMatchObject({ handlers: [{ route: taskDevRuntimeRoute }] })
    const inspect = plugin.vitehub.inspect
    const contributor = typeof inspect === "function" ? await inspect() : inspect
    const [inspector] = contributor?.definitions ?? []
    expect(inspector?.kind).toBe("task")
    expect(await inspector?.list()).toEqual([{ fields: [], file: "server/tasks/seed.ts", name: "seed", source: "server-tasks" }])
  })
})

describe("vitehub task", () => {
  it("includes metadata declared by the task handler", async () => {
    const request = new Request("http://localhost", {
      body: JSON.stringify({ operation: "list" }),
      headers: { [taskDevHeader]: taskDevHeaderValue, [taskDevTokenServerHeader]: "test-server", ["x-vitehub-dev-token"]: "test-task-token", "content-type": "application/json" },
      method: "POST",
    })
    const response = await handleTaskDevRequest(request, {
      rootDir,
      tasks: { seed: { resolve: async () => ({ meta: { description: "Seed rows" } }) } },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ tasks: [{ description: "Seed rows", name: "seed" }] })
  })

  it("keeps listing tasks when lazy metadata resolution fails", async () => {
    const request = new Request("http://localhost", {
      body: JSON.stringify({ operation: "list" }),
      headers: { [taskDevHeader]: taskDevHeaderValue, [taskDevTokenServerHeader]: "test-server", ["x-vitehub-dev-token"]: "test-task-token", "content-type": "application/json" },
      method: "POST",
    })
    const response = await handleTaskDevRequest(request, {
      rootDir,
      tasks: {
        broken: { resolve: async () => { throw new Error("cannot load task") } },
        healthy: { meta: { description: "Healthy task" } },
      },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ tasks: [{ name: "broken" }, { description: "Healthy task", name: "healthy" }] })
  })

  it("lists tasks", async () => {
    const result = context()
    const fetch = devServer({ tasks: [{ description: "Add one demo note", name: "db:seed" }, { name: "notes" }] })
    await expect(runTaskCli("list", ["--url", "http://127.0.0.1:4321"], result.context, { fetch })).resolves.toBe(0)
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:4321${taskDevRoute}`)
    expect(result.stdout.output()).toBe("NAME     DESCRIPTION\ndb:seed  Add one demo note\nnotes\n")

    const empty = context()
    await expect(runTaskCli("list", [], empty.context, { fetch: devServer({ tasks: [] }) })).resolves.toBe(0)
    expect(empty.stdout.output()).toContain("No tasks.")
  })

  it("sends --key options and --payload as the task payload", async () => {
    const result = context()
    const fetch = devServer({ durationMs: 3, name: "db:seed", result: { id: 1, title: "First" } })
    await expect(runTaskCli("run", ["db:seed", "--payload", "{\"count\":2,\"title\":\"x\"}", "--title", "First", "--dry-run", "--mode=fast"], result.context, { fetch })).resolves.toBe(0)
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ name: "db:seed", operation: "run", payload: { count: 2, title: "First", "dry-run": true, mode: "fast" } }),
      headers: { [taskDevHeader]: taskDevHeaderValue, [taskDevTokenServerHeader]: "test-server" },
      method: "POST",
    })
    expect(result.stdout.output()).toBe("Task db:seed finished in 3 ms.\n{\n  \"id\": 1,\n  \"title\": \"First\"\n}\n")
  })

  it("reports failures on stderr, or as JSON with --json", async () => {
    const failure = { error: { code: "TASK_FAILED", message: "Task \"db:seed\" failed: no such table: notes" } }
    const human = context()
    await expect(runTaskCli("run", ["db:seed"], human.context, { fetch: devServer(failure, 500) })).resolves.toBe(1)
    expect(human.stderr.output()).toBe("Task \"db:seed\" failed: no such table: notes\n")

    const json = context()
    await expect(runTaskCli("run", ["db:seed", "--json"], json.context, { fetch: devServer(failure, 500) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual(failure)

    const missing = context()
    await expect(runTaskCli("run", [], missing.context, { fetch: devServer({}) })).resolves.toBe(1)
    expect(missing.stderr.output()).toContain("Missing task name.")

    const badPayload = context()
    await expect(runTaskCli("run", ["seed", "--payload", "[1]"], badPayload.context, { fetch: devServer({}) })).resolves.toBe(1)
    expect(badPayload.stderr.output()).toContain("--payload must be a JSON object.")
  })
})

describe("Task Dev runtime handler", () => {
  const tasks = { "db:seed": { meta: { description: "Add one demo note" } }, "notes": { meta: {} } }

  function request(body: unknown, headers: Record<string, string> = { "x-vitehub-dev-token": "test-task-token", [taskDevTokenServerHeader]: "test-server" }) {
    return new Request(`http://localhost${taskDevRuntimeRoute}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", [taskDevHeader]: taskDevHeaderValue, ...headers },
      method: "POST",
    })
  }

  it("rejects a request without the private token", async () => {
    const response = await handleTaskDevRequest(request({ operation: "list" }, { "x-vitehub-dev-token": "wrong", [taskDevTokenServerHeader]: "test-server" }), { rootDir, tasks })
    expect(response.status).toBe(403)
    expect(runTask).not.toHaveBeenCalled()
  })

  it("lists tasks and runs one with Nitro's runTask", async () => {
    const list = await handleTaskDevRequest(request({ operation: "list" }), { rootDir, tasks })
    expect(await list.json()).toEqual({ tasks: [{ description: "Add one demo note", name: "db:seed" }, { name: "notes" }] })

    runTask.mockResolvedValueOnce({ result: { id: 1 } })
    const run = await handleTaskDevRequest(request({ name: "db:seed", operation: "run", payload: { title: "First" } }), { rootDir, tasks })
    expect(await run.json()).toMatchObject({ name: "db:seed", result: { id: 1 } })
    expect(runTask).toHaveBeenCalledWith("db:seed", { context: {}, payload: { title: "First" } })
  })

  it("returns 404 for an unknown task and 500 when the task throws", async () => {
    const missing = await handleTaskDevRequest(request({ name: "nope", operation: "run" }), { rootDir, tasks })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "TASK_NOT_FOUND" } })

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    runTask.mockRejectedValueOnce(new Error("no such table: notes"))
    const failed = await handleTaskDevRequest(request({ name: "db:seed", operation: "run" }), { rootDir, tasks })
    consoleError.mockRestore()
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: { code: "TASK_FAILED", message: "Task \"db:seed\" failed: no such table: notes" } })
  })
})
