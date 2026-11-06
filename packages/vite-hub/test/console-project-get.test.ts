import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { defineOperation } from "@vite-hub/internal/operations"

import packageManifest from "../package.json" with { type: "json" }
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleProjectName, installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

import type { ConsoleProject } from "../src/console/runtime/server/project.ts"

function fixtureOperation(name: string, section: string) {
  return defineOperation({ description: "Fixture.", input: v.strictObject({}), kind: "read", name, run: () => null, section })
}

const kvOperations = [fixtureOperation("kv.list", "kv"), fixtureOperation("kv.get", "kv")]
const contentOperations = [fixtureOperation("content.list", "content")]

async function project(): Promise<{ status: number, value?: ConsoleProject }> {
  const response = await handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__call", {
    body: JSON.stringify({ input: {}, operation: "project.get" }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }))
  const body = await response.json() as { value?: ConsoleProject }
  return { status: response.status, value: body.value }
}

afterEach(() => {
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
  })

  it("is refused to a caller that the Console refuses", async () => {
    installConsoleSections("/work/app", ["kv"])
    installConsoleAccess({ authorize: () => false, mode: "open" })
    expect((await project()).status).toBe(403)
  })
})
