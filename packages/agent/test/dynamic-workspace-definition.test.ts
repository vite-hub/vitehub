import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { defineAgent, runAgent } from "../src/index.ts"
import { registerWorkspace } from "@vite-hub/workspace/test"

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

  await expect(runAgent(createAgent(firstRoot), context, {})).resolves.toBe("first")
  await expect(runAgent(createAgent(secondRoot), context, {})).resolves.toBe("second")
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
