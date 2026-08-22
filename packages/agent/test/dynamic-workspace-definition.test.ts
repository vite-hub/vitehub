import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { defineAgent, runAgent } from "../src/index.ts"
import { custom } from "@vite-hub/workspace"
import { registerWorkspace } from "@vite-hub/workspace/test"

import type { WritableWorkspaceFacade } from "@vite-hub/workspace"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

it("keeps colocated Workspace Definitions invocation-local when agent names repeat", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-first-"))
  const secondRoot = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-second-"))
  roots.push(firstRoot, secondRoot)
  await writeFile(join(firstRoot, "checkout.txt"), "first")
  await writeFile(join(secondRoot, "checkout.txt"), "second")
  const name = `dynamic-workspace-${Math.random().toString(36).slice(2)}`
  const createAgent = (root: string, withSource = false) => defineAgent({
    name,
    runtime: false,
    workspace: {
      mode: "read",
      ...(withSource
        ? {
            sources: {
              firstOnly: custom({
                files: [{ content: "first source", path: "secret.txt" }],
                materialize: "lazy",
                mount: "first-only",
              }),
            },
          }
        : {}),
      store: { provider: "local", root },
    },
    driver: {
      run: async ({ workspace }) => [
        await workspace!.fs.readFile("checkout.txt"),
        await workspace!.fs.exists("first-only/secret.txt"),
      ].join(":"),
    },
  })
  const context = {
    memo<T>(_key: string, create: () => T): T {
      return create()
    },
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }

  await expect(runAgent(createAgent(firstRoot, true), context, {})).resolves.toBe("first:true")
  await expect(runAgent(createAgent(secondRoot), context, {})).resolves.toBe("second:false")
})

it("keeps concurrent colocated Workspace Definitions invocation-local when agent names repeat", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-first-"))
  const secondRoot = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-second-"))
  roots.push(firstRoot, secondRoot)
  await writeFile(join(firstRoot, "checkout.txt"), "first")
  await writeFile(join(secondRoot, "checkout.txt"), "second")
  const name = `concurrent-workspace-${Math.random().toString(36).slice(2)}`
  const createAgent = (root: string) => defineAgent({
    name,
    runtime: false,
    workspace: {
      mode: "read",
      store: { provider: "local", root },
    },
    driver: {
      run: async ({ workspace }) => await workspace!.fs.readFile("checkout.txt"),
    },
  })
  const context = {
    memo<T>(_key: string, create: () => T): T {
      return create()
    },
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }

  const first = createAgent(firstRoot)
  const second = createAgent(secondRoot)
  await expect(Promise.all([
    runAgent(first, context, {}),
    runAgent(second, context, {}),
  ])).resolves.toEqual(["first", "second"])
  await expect(Promise.all([
    runAgent(first, context, {}),
    runAgent(second, context, {}),
  ])).resolves.toEqual(["first", "second"])
})

it("does not replace a registered Workspace used by named references", async () => {
  const registeredRoot = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-registered-"))
  const inlineRoot = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-inline-"))
  roots.push(registeredRoot, inlineRoot)
  await writeFile(join(registeredRoot, "checkout.txt"), "registered")
  await writeFile(join(inlineRoot, "checkout.txt"), "inline")
  const name = `registered-workspace-${Math.random().toString(36).slice(2)}`
  registerWorkspace(name, { store: { provider: "local", root: registeredRoot } })
  const context = {
    memo<T>(_key: string, create: () => T): T {
      return create()
    },
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }

  const inline = defineAgent({
    name,
    runtime: false,
    workspace: { mode: "read", store: { provider: "local", root: inlineRoot } },
    driver: {
      run: async ({ workspace }) => await workspace!.fs.readFile("checkout.txt"),
    },
  })
  const reference = defineAgent({
    name: `${name}-reference`,
    runtime: false,
    workspace: { mode: "read", name },
    driver: {
      run: async ({ workspace }) => await workspace!.fs.readFile("checkout.txt"),
    },
  })

  await expect(runAgent(inline, context, {})).resolves.toBe("inline")
  await expect(runAgent(reference, context, {})).resolves.toBe("registered")
})

it("shares one owned Workspace across concurrent first use and later named references", async () => {
  const name = `shared-workspace-${Math.random().toString(36).slice(2)}`
  let calls = 0
  const context = {
    memo<T>(_key: string, create: () => T): T {
      return create()
    },
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }
  const owner = defineAgent({
    name,
    runtime: false,
    workspace: { mode: "write", store: { provider: "memory" } },
    driver: {
      run: async ({ workspace }) => {
        const call = ++calls
        await (workspace as WritableWorkspaceFacade).fs.writeFile(`checkout-${call}.txt`, `shared-${call}`)
        return "written"
      },
    },
  })
  const reference = defineAgent({
    name: `${name}-reference`,
    runtime: false,
    workspace: { mode: "read", name },
    driver: {
      run: async ({ workspace }) => [
        await workspace!.fs.readFile("checkout-1.txt"),
        await workspace!.fs.readFile("checkout-2.txt"),
      ].join(":"),
    },
  })

  await expect(Promise.all([
    runAgent(owner, context, {}),
    runAgent(owner, context, {}),
  ])).resolves.toEqual(["written", "written"])
  await expect(runAgent(reference, context, {})).resolves.toBe("shared-1:shared-2")
})
