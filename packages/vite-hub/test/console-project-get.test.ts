import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineOperation, operationSurfaceHeader } from "@vite-hub/internal/operations"

import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleBuild, installConsoleProjectName, installConsoleSections, installConsoleVersion } from "../src/console/runtime/server/sections.ts"
import { consoleState } from "../src/console/internal.ts"
import { taskOperations } from "../src/task/operations.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleProject } from "../src/console/runtime/server/project.ts"

function fixtureOperation(name: string, section: string) {
  return defineOperation({ description: "Fixture.", input: v.strictObject({}), kind: "read", name, run: () => null, section })
}

const kvOperations = [fixtureOperation("kv.list", "kv"), fixtureOperation("kv.get", "kv"), defineOperation({ description: "Fixture.", input: v.strictObject({}), kind: "write", name: "kv.set", run: () => null, section: "kv" })]
const contentOperations = [fixtureOperation("content.list", "content")]

async function call(operation: string, headers: Record<string, string> = {}): Promise<{ status: number, value?: unknown }> {
  const response = await handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc", {
    body: operationRpcBody(operation, {}),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1", ...headers },
    method: "POST",
  }))
  const body = await operationRpcResponseResult(response) as { value?: unknown }
  return { status: response.status, value: body.value }
}

async function project(headers: Record<string, string> = {}): Promise<{ status: number, value?: ConsoleProject }> {
  // SAFETY: project.get answers a ConsoleProject.
  return await call("project.get", headers) as { status: number, value?: ConsoleProject }
}

afterEach(() => {
  consoleState().build = undefined
  installConsoleAccess({ mode: "open" })
  installConsoleOperations([])
  installConsoleSections("/work/app", [])
})

describe("project.get", () => {
  it("answers in an app with KV and no Agents", async () => {
    installConsoleSections("/work/app", ["kv"])
    installConsoleProjectName("/work/app", "kv-app")
    installConsoleVersion("0.0.0-preview-4f9c2e1")
    installConsoleOperations([{ operations: kvOperations, plugin: "@vite-hub/kv" }])

    const { status, value } = await project()
    expect(status).toBe(200)
    expect(value).toMatchObject({ name: "kv-app", protocol: 1, sections: ["kv"], vitehub: "0.0.0-preview-4f9c2e1" })
    expect(value?.operations).toEqual(expect.arrayContaining(["kv.get", "kv.list", "project.get", "sections.list"]))
    // The Agents operations of `vite-hub` are registered, but the app has no Agents section.
    expect(value?.operations).not.toContain("status.get")
    expect(value?.operations).not.toContain("agents.list")
  })

  it("names the production build, and leaves it out on a development server", async () => {
    installConsoleSections("/work/app", ["kv"])
    expect((await project()).value).not.toHaveProperty("build")

    const build = {
      commit: { author: "Ada", branch: "main", login: "ada", message: "feat: ship", sha: "4f9c2e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f" },
      framework: { name: "nuxt" as const, version: "5.0.2" },
      host: { name: "cloudflare" as const, preset: "cloudflare-module" },
      time: "2026-11-14T10:00:00.000Z",
    }
    installConsoleBuild(build)
    expect((await project()).value?.build).toEqual(build)
  })

  it("counts open threads from the installed Comments inbox for callers with read access", async () => {
    const list = vi.fn(() => [{ status: "open" }, { status: "resolved" }, { status: "open" }])
    installConsoleSections("/work/app", ["comments", "kv"])
    expect((await project()).value).not.toHaveProperty("comments")
    installConsoleOperations([{ operations: defineOperation({
      description: "List the threads visible to this caller.",
      input: v.strictObject({ limit: v.literal(500) }),
      kind: "read",
      name: "comments.list",
      run: list,
      section: "comments",
    }) }])
    installConsoleAccess({ authorize: () => ({ sections: ["comments:read"] }), mode: "open" })
    expect((await project()).value?.comments).toEqual({ open: 2 })
    expect(list).toHaveBeenCalledOnce()

    installConsoleAccess({ authorize: () => ({ sections: ["kv"] }), mode: "open" })
    expect((await project()).value).not.toHaveProperty("comments")
    expect(list).toHaveBeenCalledOnce()
    installConsoleAccess({ mode: "open" })
    list.mockReturnValueOnce([])
    expect((await project()).value?.comments).toEqual({ open: 0 })
    list.mockImplementationOnce(() => { throw new Error("database down") })
    const failedList = await project()
    expect(failedList.status).toBe(200)
    expect(failedList.value).not.toHaveProperty("comments")
  })

  it("lists only the sections and operations that authorize allows", async () => {
    installConsoleSections("/work/app", ["kv", "content"])
    installConsoleOperations([{ operations: kvOperations, plugin: "@vite-hub/kv" }, { operations: contentOperations, plugin: "@vite-hub/content" }])
    installConsoleAccess({ authorize: () => ({ sections: ["content"] }), mode: "open" })

    const { status, value } = await project()
    expect(status).toBe(200)
    expect(value?.sections).toEqual(["content"])
    expect(value?.operations).toEqual(expect.arrayContaining(["content.list", "project.get"]))
    expect(value?.operations).not.toContain("kv.list")
    expect(value?.operations).not.toContain("kv.get")
    expect(value?.operations).not.toContain("kv.set")
  })

  it("leaves out the write operations of a read-only section grant", async () => {
    installConsoleSections("/work/app", ["kv"])
    installConsoleOperations([{ operations: kvOperations, plugin: "@vite-hub/kv" }])
    expect((await project()).value?.operations).toContain("kv.set")

    installConsoleAccess({ authorize: () => ({ sections: ["kv:read"] }), mode: "open" })
    const { value } = await project()
    expect(value?.sections).toEqual(["kv"])
    expect(value?.operations).toEqual(expect.arrayContaining(["kv.get", "kv.list"]))
    expect(value?.operations).not.toContain("kv.set")
  })

  it.each([
    { grant: "tasks", invoke: true, runnable: true },
    { grant: "tasks", invoke: false, runnable: false },
    { grant: "tasks:read", invoke: true, runnable: false },
  ])("lists tasks without a navigation page ($grant, invoke: $invoke)", async ({ grant, invoke, runnable }) => {
    installConsoleSections("/work/app", ["kv"])
    installConsoleOperations([{ operations: taskOperations, plugin: "vite-hub/task" }], { invoke })
    installConsoleAccess({ authorize: () => ({ sections: [grant] }), mode: "open" })

    const { status, value } = await project()
    expect(status).toBe(200)
    expect(value?.sections).toEqual([])
    expect(value?.operations).toContain("task.list")
    expect(value?.operations.includes("task.run")).toBe(runnable)

    installConsoleAccess({ authorize: () => ({ sections: ["kv"] }), mode: "open" })
    const denied = await project()
    expect(denied.value?.operations).not.toContain("task.list")
    expect(denied.value?.operations).not.toContain("task.run")
  })

  it("lists contributed operations with no navigation sections in development RPC", async () => {
    installConsoleSections("/work/app", [])
    installConsoleOperations([{ operations: kvOperations, plugin: "@vite-hub/kv" }])

    const { status, value } = await project()
    expect(status).toBe(200)
    expect(value?.sections).toEqual([])
    expect(value?.operations).toEqual(expect.arrayContaining(["kv.list", "kv.get", "kv.set"]))
    expect(value?.operations).not.toContain("agents.list")
  })

  it("sends the Console page its sections.list answer, so the page opens the project with one call", async () => {
    installConsoleSections("/work/app", ["kv"])
    installConsoleProjectName("/work/app", "kv-app")
    installConsoleOperations([{ operations: kvOperations, plugin: "@vite-hub/kv" }])
    const sections = await call("sections.list")
    const { value } = await project()
    expect(value?.navigation).toMatchObject({ projectName: "kv-app", sections: ["kv"] })
    expect(value?.navigation).toEqual(sections.value)
    // `vitehub project info` reads the project, not the page.
    expect((await project({ [operationSurfaceHeader]: "cli" })).value).not.toHaveProperty("navigation")
  })

  it("is refused to a caller that the Console refuses", async () => {
    installConsoleSections("/work/app", ["kv"])
    installConsoleAccess({ authorize: () => false, mode: "open" })
    expect((await project()).status).toBe(403)
  })
})
