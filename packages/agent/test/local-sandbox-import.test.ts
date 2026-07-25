import { rm } from "node:fs/promises"
import { basename, dirname } from "node:path"

import { expect, it, vi } from "vitest"

const { randomUUID } = vi.hoisted(() => ({
  randomUUID: vi.fn(() => "123e4567-e89b-42d3-a456-426614174000"),
}))

vi.mock("node:crypto", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomUUID,
}))

it("creates and reuses the cleanup owner only when a session starts", async () => {
  const { createLocalHarnessSandbox } = await import("../src/harness/local-sandbox.ts")

  expect(randomUUID).not.toHaveBeenCalled()

  const provider = createLocalHarnessSandbox()
  const first = await provider.createSession({ sessionId: "first" })
  const second = await provider.createSession({ sessionId: "second" })
  const firstOwner = dirname((first as unknown as { rootDir: string }).rootDir)
  const secondOwner = dirname((second as unknown as { rootDir: string }).rootDir)

  try {
    expect(randomUUID).toHaveBeenCalledOnce()
    expect(basename(firstOwner)).toBe(`owner-${process.pid}-123e4567-e89b-42d3-a456-426614174000`)
    expect(secondOwner).toBe(firstOwner)
  }
  finally {
    await Promise.all([first.destroy?.(), second.destroy?.()])
    await rm(firstOwner, { force: true, recursive: true })
  }
})
