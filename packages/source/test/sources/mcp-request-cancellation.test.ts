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

it("interrupts server initialization when the configured request signal aborts", async () => {
  const controller = new AbortController()
  let resolveServer!: () => void
  const ready = new Promise<void>((resolve) => { resolveServer = resolve })
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const listResources = vi.fn(async () => ({ resources: [] }))
  const source = mcpResources({
    request: { signal: controller.signal },
    server: async () => {
      markStarted()
      await ready
      return { listResources, async readResource() { return { contents: [] } } }
    },
  })
  const reason = new Error("Request canceled")
  const operation = source.getKeys({ rootDir: process.cwd() })
  const rejection = expect(operation).rejects.toBe(reason)
  await started
  controller.abort(reason)
  resolveServer()
  await rejection
  expect(listResources).not.toHaveBeenCalled()
})
