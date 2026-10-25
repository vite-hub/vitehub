import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const runTask = vi.hoisted(() => vi.fn())
vi.mock("nitro/task", () => ({ runTask }))

import { taskOperations } from "../src/task/operations.ts"
import { taskRegistryKey } from "../src/task/registry.ts"
import { discoverTaskDefinitions } from "../src/task/discovery.ts"
import { viteHubTaskPlugin } from "../src/task/vite.ts"

import { collectOperationContributions, operationCliPath, operationsOf } from "@vite-hub/internal/operations"

import type { OperationContext } from "@vite-hub/internal/operations"

const scope = globalThis as Record<symbol, unknown>
const registryKey = Symbol.for(taskRegistryKey)
const context: OperationContext = { access: { mode: "local", sections: "all" }, surface: "cli", user: null }
const roots: string[] = []

afterEach(async () => {
  runTask.mockReset()
  Reflect.deleteProperty(scope, registryKey)
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
    expect(config.nitro).toMatchObject({
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

  it("contributes the task operations only when the app has tasks", async () => {
    const withTasks = await runConfigHook(await project({ "server/tasks/seed.ts": "" }))
    const without = await runConfigHook(await project({}))

    const [contribution] = await collectOperationContributions([withTasks.plugin])
    expect(contribution).toMatchObject({ export: "taskOperations", module: "vite-hub/_internal/task/operations" })
    expect(operationsOf(await contribution?.load?.()).map(operation => operation.name)).toEqual(["task.list", "task.run"])
    await expect(collectOperationContributions([without.plugin])).resolves.toEqual([])
  })

  it("enables Nitro tasks for tasks declared in Nitro config", async () => {
    const empty = await project({})
    expect((await runConfigHook(empty, { tasks: { seed: { handler: "/tmp/seed.ts" } } })).config.nitro).toMatchObject({
      experimental: { tasks: true },
      tasks: { seed: { handler: "/tmp/seed.ts" } },
    })
  })

  it("registers the Nitro plugin that hands over the tasks, and lists tasks for inspection", async () => {
    const root = await project({ "server/tasks/seed.ts": "" })
    const { config, plugin } = await runConfigHook(root)
    expect(config.nitro).toMatchObject({ plugins: [join(root, ".vitehub/nitro/task/registry.mjs")] })
    expect(await readFile(join(root, ".vitehub/nitro/task/registry.mjs"), "utf8")).toContain("#nitro/virtual/tasks")
    const inspect = plugin.vitehub.inspect
    const contributor = typeof inspect === "function" ? await inspect() : inspect
    const [inspector] = contributor?.definitions ?? []
    expect(inspector?.kind).toBe("task")
    expect(await inspector?.list()).toEqual([{ fields: [], file: "server/tasks/seed.ts", name: "seed", source: "server-tasks" }])
  })
})

function operation(name: string) {
  const found = taskOperations.find(candidate => candidate.name === name)
  if (!found) throw new TypeError(`No operation ${name}.`)
  return found
}

function call(name: string, input: unknown): Promise<unknown> {
  return Promise.resolve((operation(name).run as (input: unknown, context: OperationContext) => unknown)(input, context))
}

describe("task operations", () => {
  const tasks = { "db:seed": { meta: { description: "Add one demo note" } }, notes: { meta: {} } }

  it("names task.list and task.run under `vitehub task`", () => {
    expect(taskOperations.map(({ kind, name, section }) => ({ kind, name, section }))).toEqual([
      { kind: "read", name: "task.list", section: "tasks" },
      { kind: "write", name: "task.run", section: "tasks" },
    ])
    expect(taskOperations.map(operationCliPath)).toEqual([{ command: "list", namespace: "task" }, { command: "run", namespace: "task" }])
  })

  it("lists the registered tasks with their descriptions", async () => {
    scope[registryKey] = {
      ...tasks,
      lazy: { resolve: async () => ({ meta: { description: "Seed rows" } }) },
    }
    await expect(call("task.list", {})).resolves.toEqual({ tasks: [{ description: "Add one demo note", name: "db:seed" }, { description: "Seed rows", name: "lazy" }, { name: "notes" }] })
  })

  it("keeps listing tasks when lazy metadata resolution fails", async () => {
    scope[registryKey] = {
      broken: { resolve: async () => { throw new Error("cannot load task") } },
      healthy: { meta: { description: "Healthy task" } },
    }
    await expect(call("task.list", {})).resolves.toEqual({ tasks: [{ name: "broken" }, { description: "Healthy task", name: "healthy" }] })
  })

  it("runs a task with Nitro's runTask and returns its result", async () => {
    scope[registryKey] = tasks
    runTask.mockResolvedValueOnce({ result: { id: 1 } })

    await expect(call("task.run", { name: "db:seed", payload: { title: "First" } })).resolves.toMatchObject({ name: "db:seed", result: { id: 1 } })
    expect(runTask).toHaveBeenCalledWith("db:seed", { context: {}, payload: { title: "First" } })
  })

  it("fails with TASK_NOT_FOUND for an unknown task, and does not run it", async () => {
    scope[registryKey] = tasks

    await expect(call("task.run", { name: "nope" })).rejects.toMatchObject({ code: "TASK_NOT_FOUND", status: 404 })
    expect(runTask).not.toHaveBeenCalled()
  })

  it("does not run a name that only the prototype defines", async () => {
    scope[registryKey] = tasks

    await expect(call("task.run", { name: "toString" })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" })
  })

  it("fails with TASK_FAILED, and the message, when the task throws", async () => {
    scope[registryKey] = tasks
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    runTask.mockRejectedValueOnce(new Error("no such table: notes"))

    await expect(call("task.run", { name: "db:seed" })).rejects.toMatchObject({ code: "TASK_FAILED", message: "Task \"db:seed\" failed: no such table: notes", status: 500 })
    consoleError.mockRestore()
  })

  it("fails with TASK_NOT_IMPLEMENTED for a task file without run()", async () => {
    scope[registryKey] = tasks
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    runTask.mockRejectedValueOnce(Object.assign(new Error("Task `db:seed` is not implemented!"), { status: 501 }))

    await expect(call("task.run", { name: "db:seed" })).rejects.toMatchObject({ code: "TASK_NOT_IMPLEMENTED", status: 501 })
    consoleError.mockRestore()
  })

  it("fails with TASK_RUNTIME_UNAVAILABLE when the server did not install the registry", async () => {
    await expect(call("task.list", {})).rejects.toMatchObject({ code: "TASK_RUNTIME_UNAVAILABLE", status: 503 })
    await expect(call("task.run", { name: "seed" })).rejects.toMatchObject({ code: "TASK_RUNTIME_UNAVAILABLE" })
  })
})
