import { expect, it, vi } from "vitest"

import { mcpResources } from "../../src/mcp.ts"

it("does not resolve a server when the configured request signal is already aborted", async () => {
  const reason = new Error("Request canceled")
  const server = vi.fn(async () => ({
    async listResources() { return { resources: [] } },
    async readResource() { return { contents: [] } },
  }))
  const source = mcpResources({ server, request: { signal: AbortSignal.abort(reason) } })
  await expect(source.getKeys({ rootDir: process.cwd() })).rejects.toBe(reason)
  expect(server).not.toHaveBeenCalled()
})

it.each(["request", "context"] as const)("interrupts server initialization when the %s signal aborts", async (origin) => {
  const controller = new AbortController()
  const contextController = new AbortController()
  let factorySignal: AbortSignal | undefined
  let resolveServer!: () => void
  const ready = new Promise<void>((resolve) => { resolveServer = resolve })
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const listResources = vi.fn(async () => ({ resources: [] }))
  const source = mcpResources({
    request: { signal: controller.signal },
    server: async (ctx) => {
      factorySignal = ctx.abortSignal
      markStarted()
      await ready
      return { listResources, async readResource() { return { contents: [] } } }
    },
  })
  const reason = new Error("Request canceled")
  const operation = source.getKeys({ rootDir: process.cwd(), abortSignal: contextController.signal })
  const rejection = expect(operation).rejects.toBe(reason)
  await started
  const canceled = origin === "request" ? controller : contextController
  canceled.abort(reason)
  resolveServer()
  await rejection
  expect(factorySignal?.aborted).toBe(true)
  expect(factorySignal?.reason).toBe(reason)
  expect(listResources).not.toHaveBeenCalled()
})
