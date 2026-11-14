import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { defineOperation } from "@vite-hub/internal/operations"

import packageManifest from "../package.json" with { type: "json" }
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleBuild, installConsoleProjectName, installConsoleSections } from "../src/console/runtime/server/sections.ts"
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

async function project(): Promise<{ status: number, value?: ConsoleProject }> {
  const response = await handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc", {
    body: operationRpcBody("project.get", {}),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }))
  const body = await operationRpcResponseResult(response) as { value?: ConsoleProject }
  return { status: response.status, value: body.value }
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
    installConsoleOperations([{ operations: kvOperations, plugin: "@vite-hub/kv" }])

    const { status, value } = await project()
    expect(status).toBe(200)
    expect(value).toMatchObject({ name: "kv-app", protocol: 1, sections: ["kv"], vitehub: packageManifest.version })
    expect(value?.operations).toEqual(expect.arrayContaining(["kv.get", "kv.list", "project.get", "sections.list"]))
    // The Agents operations of `vite-hub` are registered, but the app has no Agents section.
    expect(value?.operations).not.toContain("status.get")
    expect(value?.operations).not.toContain("agents.list")
  })

  it("names the production build, and leaves it out on a development server", async () => {
    installConsoleSections("/work/app", ["kv"])
    expect((await project()).value).not.toHaveProperty("build")

    const build = { commit: { author: "Ada", branch: "main", message: "feat: ship", sha: "4f9c2e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f" }, time: "2026-11-14T10:00:00.000Z" }
    installConsoleBuild(build)
    expect((await project()).value?.build).toEqual(build)
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

  it("is refused to a caller that the Console refuses", async () => {
    installConsoleSections("/work/app", ["kv"])
    installConsoleAccess({ authorize: () => false, mode: "open" })
    expect((await project()).status).toBe(403)
  })
})
